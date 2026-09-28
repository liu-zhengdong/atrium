package leaders

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 夹具：o1（a1）→ o2（a2）；o3 顶层没有负责人。t1 在 o2，t2 在 o3。
func fixture(t *testing.T) (*app.Env, *hub, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	ctx := context.Background()
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Pause: &pause.Store{DB: db}}
	for _, name := range []string{"总部", "运行时"} {
		if _, err := org.AddLeader(ctx, db, org.NewLeader{Name: name, Workers: []string{"fake"}}); err != nil {
			t.Fatal(err)
		}
	}
	must := func(_ any, err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(org.Add(ctx, db, org.NewDept{Name: "公司", Leader: "a1"}))
	must(org.Add(ctx, db, org.NewDept{Name: "运行时", Parent: "o1", Leader: "a2"}))
	must(org.Add(ctx, db, org.NewDept{Name: "别处"}))
	must(org.AddPoint(ctx, db, "o1", org.NewPoint{Text: "简洁优先"}, "u1"))
	must(ledger.Add(ctx, db, ledger.NewTask{Title: "在 o2", Org: "o2"}, "u1"))
	must(ledger.Add(ctx, db, ledger.NewTask{Title: "在 o3", Org: "o3"}, "u1"))

	h := newHub()
	h.batch, h.tick = 0, 10*time.Millisecond
	r := api.NewRouter(nil)
	r.AddAuth(func(tok string) (api.Actor, bool) { return api.Actor{ID: "u1", Kind: "user"}, tok == "user" })
	ledger.Routes(r, env)
	org.Routes(r, env)
	moduleFor(h).Routes(r, env)
	r.Handle("POST /api/events/ack", func(q *api.Req) (any, error) { return "acked", nil }) // 代替 events 包的确认接口
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return env, h, srv
}

func code(err error) string {
	var ae *api.Error
	if errors.As(err, &ae) {
		return ae.Code
	}
	if err == nil {
		return "ok"
	}
	return err.Error()
}

func TestLeaderGuard(t *testing.T) {
	env, h, srv := fixture(t)
	ctx := context.Background()
	tok, _ := h.issue("a2")
	a2 := &api.Client{Base: srv.URL, Token: tok}
	user := &api.Client{Base: srv.URL, Token: "user"}
	events.Emit(ctx, env.DB, events.Event{Kind: "x", Target: "a2"})        // #1
	events.Emit(ctx, env.DB, events.Event{Kind: "x", Target: "secretary"}) // #2

	cases := []struct {
		name, method, path string
		body               any
		want               string
	}{
		{"读任务", "GET", "/api/tasks/t2", nil, "ok"},
		{"读部门树", "GET", "/api/org", nil, "ok"},
		{"本部门任务写备注", "POST", "/api/tasks/t1/notes", map[string]string{"text": "记一笔"}, "ok"},
		{"别处任务写备注", "POST", "/api/tasks/t2/notes", map[string]string{"text": "记一笔"}, "forbidden"},
		{"不存在的任务", "POST", "/api/tasks/t9/notes", map[string]string{"text": "x"}, "not_found"},
		{"在本部门建任务", "POST", "/api/tasks", map[string]string{"title": "新活", "org": "o2"}, "ok"},
		{"挂在本部门任务下", "POST", "/api/tasks", map[string]string{"title": "子活", "parent": "t1"}, "ok"},
		{"建任务不写部门", "POST", "/api/tasks", map[string]string{"title": "新活"}, "forbidden"},
		{"在上级部门建任务", "POST", "/api/tasks", map[string]string{"title": "新活", "org": "o1"}, "forbidden"},
		{"把任务挪出管辖", "PATCH", "/api/tasks/t1", map[string]string{"org": "o3"}, "forbidden"},
		{"改本部门任务", "PATCH", "/api/tasks/t1", map[string]string{"title": "改名"}, "ok"},
		{"本部门加要点", "POST", "/api/org/o2/points", map[string]string{"text": "单实例"}, "ok"},
		{"上级加要点", "POST", "/api/org/o1/points", map[string]string{"text": "x"}, "forbidden"},
		{"改上级要点", "PATCH", "/api/points/k1", map[string]string{"text": "x"}, "forbidden"},
		{"改部门本身", "PATCH", "/api/org/o2", map[string]string{"now": "x"}, "forbidden"},
		{"建部门", "POST", "/api/org", map[string]string{"name": "x"}, "forbidden"},
		{"登记负责人", "POST", "/api/leaders", map[string]any{"name": "x", "workers": []string{"c"}}, "forbidden"},
		{"写自己的备忘", "PUT", "/api/memo", map[string]string{"body": "下次先看 t1"}, "ok"},
		{"读秘书备忘", "GET", "/api/memo?as=secretary", nil, "forbidden"},
		{"写别人备忘", "PUT", "/api/memo?as=a1", map[string]string{"body": "x"}, "forbidden"},
		{"确认投给自己的事件", "POST", "/api/events/ack", map[string]any{"ids": []int{1}}, "ok"},
		{"确认投给秘书的事件", "POST", "/api/events/ack", map[string]any{"ids": []int{1, 2}}, "forbidden"},
		{"没注册的写接口", "POST", "/api/nothing", nil, "not_found"},
	}
	for _, c := range cases {
		err := a2.Do(ctx, c.method, c.path, c.body, nil)
		if got := code(err); got != c.want {
			t.Errorf("%s：%s，应为 %s", c.name, got, c.want)
		}
		var ae *api.Error
		if c.want == "forbidden" && errors.As(err, &ae) && !strings.Contains(ae.Next, "leader escalate") && ae.Next != "" {
			t.Errorf("%s：越权提示应指向上交：%q", c.name, ae.Next)
		}
	}
	// 用户令牌不受影响。
	if err := user.Do(ctx, "POST", "/api/tasks/t2/notes", map[string]string{"text": "x"}, nil); err != nil {
		t.Fatalf("用户令牌：%v", err)
	}
	// 作废后 401。
	h.revoke(tok)
	if got := code(a2.Do(ctx, "GET", "/api/org", nil, nil)); got != "unauthorized" {
		t.Fatalf("作废令牌：%s", got)
	}
}

func TestEscalate(t *testing.T) {
	env, h, srv := fixture(t)
	ctx := context.Background()
	t2, _ := h.issue("a2")
	t1, _ := h.issue("a1")
	a2 := &api.Client{Base: srv.URL, Token: t2}
	a1 := &api.Client{Base: srv.URL, Token: t1}
	user := &api.Client{Base: srv.URL, Token: "user"}

	var out Escalation
	if err := a2.Do(ctx, "POST", "/api/escalations", EscalateIn{Kind: "stuck", Note: "卡了三次", Task: "t1"}, &out); err != nil || out.To != "a1" {
		t.Fatalf("a2 上交应投 a1：%+v %v", out, err)
	}
	var target, kind, body string
	env.DB.QueryRowContext(ctx, `SELECT target, kind, body FROM events ORDER BY id DESC LIMIT 1`).Scan(&target, &kind, &body)
	if target != "a1" || kind != events.LeaderEscalate || !strings.Contains(body, "卡了三次") {
		t.Fatalf("上交事件：%s %s %s", target, kind, body)
	}
	hist, _ := ledger.History(ctx, env.DB, "t1", 100)
	if hist[len(hist)-1].Kind != "escalated" {
		t.Fatalf("任务经历应记上交：%+v", hist)
	}
	// a1 转交这一条（#1）往上：顶层投秘书，带原文。
	if err := a1.Do(ctx, "POST", "/api/escalations", EscalateIn{Kind: "stuck", Note: "同意，要用户定", Event: 1}, &out); err != nil || out.To != "secretary" || out.Task != "t1" {
		t.Fatalf("a1 转交：%+v %v", out, err)
	}
	env.DB.QueryRowContext(ctx, `SELECT body FROM events ORDER BY id DESC LIMIT 1`).Scan(&body)
	if !strings.Contains(body, "卡了三次") || !strings.Contains(body, "同意") {
		t.Fatalf("转交要带原文与意见：%s", body)
	}
	for name, c := range map[string]struct {
		cl   *api.Client
		in   EscalateIn
		want string
	}{
		"别处任务":    {a2, EscalateIn{Kind: "stuck", Note: "x", Task: "t2"}, "forbidden"},
		"转交别人的事件": {a2, EscalateIn{Kind: "stuck", Note: "x", Event: 2}, "forbidden"},
		"用户不上交":   {user, EscalateIn{Kind: "stuck", Note: "x"}, "forbidden"},
		"类型不对":    {a2, EscalateIn{Kind: "help", Note: "x"}, "usage"},
		"已上线不给任务": {a2, EscalateIn{Kind: "shipped", Note: "x"}, "usage"},
		"不存在的事件":  {a2, EscalateIn{Kind: "stuck", Note: "x", Event: 99}, "not_found"},
	} {
		if got := code(c.cl.Do(ctx, "POST", "/api/escalations", c.in, nil)); got != c.want {
			t.Errorf("%s：%s，应为 %s", name, got, c.want)
		}
	}
}

// fakeLauncher 记下每次唤醒；ack 为真时模拟负责人确认了这批事件。
type fakeLauncher struct {
	h     *hub
	db    *store.DB
	ack   bool
	cmd   string
	calls atomic.Int32
	seen  []Launch
}

func (f *fakeLauncher) launch(ctx context.Context, l Launch) (platform.Spec, error) {
	f.calls.Add(1)
	f.seen = append(f.seen, l)
	if _, ok := f.h.auth(l.Env["ATRIUM_LEADER_TOKEN"]); !ok {
		return platform.Spec{}, errors.New("令牌应在唤醒期间有效")
	}
	if f.ack {
		if _, err := f.db.ExecContext(ctx, `UPDATE events SET acked_at = 1 WHERE target = ?`, l.Leader); err != nil {
			return platform.Spec{}, err
		}
	}
	s := platform.Shell(f.cmd)
	s.Env = l.Env
	return s, nil
}

func TestWake(t *testing.T) {
	env, h, _ := fixture(t)
	ctx := context.Background()
	f := &fakeLauncher{h: h, db: env.DB, ack: true, cmd: "exit 0"}
	SetLauncher(f.launch)
	t.Cleanup(func() { SetLauncher(nil) })
	round := func() {
		t.Helper()
		if err := h.round(ctx, env); err != nil {
			t.Fatal(err)
		}
		h.wg.Wait()
	}
	targetOf := func(id int) string {
		var s string
		env.DB.QueryRowContext(ctx, `SELECT target FROM events WHERE id = ?`, id).Scan(&s)
		return s
	}

	// 成功：处理完确认，令牌随即作废；提示词带部门、要点链、事件。
	events.Emit(ctx, env.DB, events.Event{Kind: events.TaskStatus, Task: "t1", Dept: "o2", Target: "a2"})
	round()
	if f.calls.Load() != 1 || h.fails["a2"] != 0 {
		t.Fatalf("应唤醒一次且成功：calls=%d fails=%d", f.calls.Load(), h.fails["a2"])
	}
	l := f.seen[0]
	if l.Profile != "fake" || l.Env["ATRIUM_WORKER"] != "" || l.Env["ATRIUM_DATA"] != env.Paths.Data ||
		!strings.Contains(l.Prompt, "k1（o1）简洁优先") || !strings.Contains(l.Prompt, "#1") || !strings.Contains(l.Prompt, "投给 a1") {
		t.Fatalf("唤醒输入不对：%+v", l)
	}
	if _, ok := h.auth(l.Env["ATRIUM_LEADER_TOKEN"]); ok {
		t.Fatal("唤醒结束令牌应作废")
	}
	round()
	if f.calls.Load() != 1 {
		t.Fatal("没有新事件不该再唤醒")
	}

	// 没处理完：第一次记失败，第二次转交上一层（a1）。
	f.ack = false
	events.Emit(ctx, env.DB, events.Event{Kind: events.TaskStatus, Task: "t1", Dept: "o2", Target: "a2"}) // #2
	round()
	if h.fails["a2"] != 1 || targetOf(2) != "a2" {
		t.Fatalf("第一次失败：fails=%d target=%s", h.fails["a2"], targetOf(2))
	}
	round()
	if h.fails["a2"] != 0 || targetOf(2) != "a1" {
		t.Fatalf("连续两次应转交 a1：fails=%d target=%s", h.fails["a2"], targetOf(2))
	}

	// 停机：不唤醒。
	env.Pause.Set(ctx, "o1", "u1")
	before := f.calls.Load()
	round()
	if f.calls.Load() != before {
		t.Fatal("部门暂停时不该唤醒")
	}
	env.Pause.Clear(ctx, "o1")

	// 没接拉起接口：直接算失败，两次后 a1 顶层转交秘书。
	SetLauncher(nil)
	round()
	round()
	if targetOf(2) != "secretary" {
		t.Fatalf("a1 连续失败应转交秘书：%s", targetOf(2))
	}
}

func TestWakeTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("用 sleep 模拟卡住")
	}
	env, h, _ := fixture(t)
	ctx := context.Background()
	h.timeout = 200 * time.Millisecond
	f := &fakeLauncher{h: h, db: env.DB, cmd: "sleep 30"}
	SetLauncher(f.launch)
	t.Cleanup(func() { SetLauncher(nil) })
	events.Emit(ctx, env.DB, events.Event{Kind: "x", Target: "a2"})
	start := time.Now()
	if err := h.round(ctx, env); err != nil {
		t.Fatal(err)
	}
	h.wg.Wait()
	if time.Since(start) > 5*time.Second || h.fails["a2"] != 1 {
		t.Fatalf("超时应结束并记失败：%s fails=%d", time.Since(start), h.fails["a2"])
	}
}

func TestWakeEnabled(t *testing.T) {
	def, _ := config.Resolve(func(string) string { return "" })
	env := func(v string) func(string) string { return func(string) string { return v } }
	if !wakeEnabled(def.Data, env("")) || wakeEnabled(t.TempDir(), env("")) || !wakeEnabled(t.TempDir(), env("1")) {
		t.Fatal("只在缺省数据目录或 ATRIUM_LEADER_WAKE=1 时唤醒")
	}
}
