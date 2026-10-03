package leaders

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"io"
	"log/slog"
	"net"
	"net/http/httptest"
	"os"
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
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 夹具：o1（a1）→ o2（a2）；o3 顶层没有负责人。t1 在 o2，t2 在 o3。
func fixture(t *testing.T) (*app.Env, *hub, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir) // 假主目录：全局原则读这里的 AGENTS.md，不读开发者本机的
	t.Setenv("USERPROFILE", dir)
	os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("先给结论"), 0o600)
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
	events.Routes(r, env) // 真的事件接口：负责人令牌按真实路由形状过权限判定
	agenda.Routes(r, env)
	// 改档案与解除标记的真处理在 workers。本包测试引它会成环（workers 调 SetLauncher），
	// 所以只挂同形路由：权限判定走 RuleFor 与 InScope，处理函数不写档案。
	noop := func(q *api.Req) (any, error) { return map[string]bool{"ok": true}, nil }
	r.Handle("POST /api/workers/edit", noop)
	r.Handle("POST /api/workers/clear", noop)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return env, h, srv
}

// profileLine 造出档案所属部门，返回一个管辖不到它的负责人。
// 夹具是 o1（a1）→ o2（a2）。档案部门挂在 o2 下且不设负责人，a2 沿管辖包含它；新负责人只管另一个顶层部门。
func profileLine(t *testing.T, db *store.DB) string {
	t.Helper()
	ctx := context.Background()
	who, err := org.AddLeader(ctx, db, org.NewLeader{Name: "线外", Workers: []string{"fake"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := org.Add(ctx, db, org.NewDept{Name: "线外", Leader: who.ID}); err != nil {
		t.Fatal(err)
	}
	var id string
	for i := 0; i < 20 && id != ProfileDept; i++ {
		d, err := org.Add(ctx, db, org.NewDept{Name: "分派任务", Parent: "o2"})
		if err != nil {
			t.Fatal(err)
		}
		id = d.ID
	}
	if id != ProfileDept {
		t.Fatalf("没有建出档案部门 %s，最后是 %s", ProfileDept, id)
	}
	return who.ID
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

// choice 是一份最小的合法选项单。
func choice(dept string) map[string]any {
	opt := map[string]string{"title": "A", "gain": "g", "why_now": "w", "cost": "c", "if_not": "i", "evidence": "e"}
	return map[string]any{"org": dept, "title": "下一步", "options": []any{opt, opt, opt}, "recommend": []int{1}, "reason": "r"}
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
		{"改本部门介绍", "PATCH", "/api/org/o2", map[string]string{"what": "w", "uses": "u", "now": "n", "next": "下一步"}, "ok"},
		{"改上级部门介绍", "PATCH", "/api/org/o1", map[string]string{"next": "x"}, "forbidden"},
		{"改别处部门介绍", "PATCH", "/api/org/o3", map[string]string{"next": "x"}, "forbidden"},
		// 下面几条若被放行会改掉 o2，彼此连带；按「放行后破坏最小」排，头一条漏判就能看出来。
		{"介绍里夹改名", "PATCH", "/api/org/o2", map[string]string{"next": "x", "name": "改名"}, "forbidden"},
		{"删本部门", "PATCH", "/api/org/o2", map[string]any{"delete": true}, "forbidden"},
		{"改负责人（大写键名）", "PATCH", "/api/org/o2", map[string]string{"Leader": "a1"}, "forbidden"},
		{"改本部门负责人", "PATCH", "/api/org/o2", map[string]string{"leader": "a1"}, "forbidden"},
		{"建部门", "POST", "/api/org", map[string]string{"name": "x"}, "forbidden"},
		{"登记负责人", "POST", "/api/leaders", map[string]any{"name": "x", "workers": []string{"c"}}, "forbidden"},
		{"写自己的备忘", "PUT", "/api/memo", map[string]string{"body": "下次先看 t1"}, "ok"},
		{"读秘书备忘", "GET", "/api/memo?as=secretary", nil, "forbidden"},
		{"写别人备忘", "PUT", "/api/memo?as=a1", map[string]string{"body": "x"}, "forbidden"},
		{"确认发给自己的事件", "POST", "/api/events/ack", map[string]any{"ids": []int{1}}, "ok"},
		{"确认发给秘书的事件", "POST", "/api/events/ack", map[string]any{"ids": []int{1, 2}}, "forbidden"},
		{"取自己的事件", "GET", "/api/events/wait?timeout=0", nil, "ok"},
		{"取别人的事件", "GET", "/api/events/wait?timeout=0&as=a1", nil, "forbidden"},
		{"本部门递选项单", "POST", "/api/choices", choice("o2"), "ok"},
		{"别处递选项单", "POST", "/api/choices", choice("o3"), "forbidden"},
		{"拍板", "POST", "/api/choices/c1/decide", map[string]any{"picks": []int{1}}, "forbidden"},
		{"本部门定时任务", "POST", "/api/schedules", map[string]any{"org": "o2", "title": "巡检", "every": "1d"}, "ok"},
		{"别处定时任务", "POST", "/api/schedules", map[string]any{"org": "o3", "title": "巡检", "every": "1d"}, "forbidden"},
		// 报告连图片一次加：请求体过 1MB，权限判定要读全再判，不能截断（t449）。
		{"本部门加过 1MB 的资料", "POST", "/api/materials", org.MaterialInput{Org: "o2", Title: "t449-show", Note: "报告", Files: []org.MaterialFile{
			{Name: "report.md", Content: []byte("# 报告\n![](images/arch.png)\n")},
			{Name: "images/arch.png", Content: append([]byte{0x89, 0}, make([]byte, 1<<20)...)}}}, "ok"},
		{"别处加过 1MB 的资料", "POST", "/api/materials", org.MaterialInput{Org: "o3", Note: "报告", Files: []org.MaterialFile{
			{Name: "images/arch.png", Content: append([]byte{0x89, 0}, make([]byte, 1<<20)...)}}}, "forbidden"},
		{"没注册的写接口", "POST", "/api/nothing", nil, "not_found"},
	}
	for _, c := range cases {
		err := a2.Do(ctx, c.method, c.path, c.body, nil)
		if got := code(err); got != c.want {
			t.Errorf("%s：%s，应为 %s", c.name, got, c.want)
		}
		var ae *api.Error
		if c.want == "forbidden" && errors.As(err, &ae) && !strings.Contains(ae.Next, "leader escalate") && ae.Next != "" {
			t.Errorf("%s：越权提示应指向上报：%q", c.name, ae.Next)
		}
	}
	for path, body := range map[string]any{
		"/api/org/o1/points": map[string]string{"text": "x"},
		"/api/org/o1":        map[string]string{"next": "x"},
		"/api/tasks":         map[string]string{"title": "新活", "org": "o1"},
	} {
		method := "POST"
		if path == "/api/org/o1" {
			method = "PATCH"
		}
		var ae *api.Error
		if err := a2.Do(ctx, method, path, body, nil); !errors.As(err, &ae) || !strings.HasPrefix(ae.Message, "部门 o1 ") {
			t.Errorf("%s %s 越部门的说明应写出目标部门：%v", method, path, err)
		}
	}
	// 介绍真改上了，别的字段没动；上级负责人改下属部门介绍放行。
	d, err := org.Get(ctx, env.DB, "o2")
	if err != nil || d.Next != "下一步" || d.Name != "运行时" || d.Leader != "a2" {
		t.Fatalf("o2 应只改了介绍：%+v %v", d, err)
	}
	tok1, _ := h.issue("a1")
	a1 := &api.Client{Base: srv.URL, Token: tok1}
	if err := a1.Do(ctx, "PATCH", "/api/org/o2", map[string]string{"next": "上级写的"}, &d); err != nil || d.Next != "上级写的" {
		t.Fatalf("上级负责人改下属部门介绍：%+v %v", d, err)
	}
	// 被拒时说明自己直接管的地方要上报。
	var ae *api.Error
	if err := a2.Do(ctx, "PATCH", "/api/org/o2", map[string]string{"name": "x"}, nil); !errors.As(err, &ae) || !strings.Contains(ae.Message, "交上一层") {
		t.Fatalf("改名被拒要说明归属：%v", err)
	}
	// 用户令牌不受影响。
	if err := user.Do(ctx, "POST", "/api/tasks/t2/notes", map[string]string{"text": "x"}, nil); err != nil {
		t.Fatalf("用户令牌：%v", err)
	}
	// 执行者档案归分派任务部门：挂在 o2 下，a2 的管辖包含它；另一位负责人只管线外的顶层部门。
	outside := profileLine(t, env.DB)
	tokOut, _ := h.issue(outside)
	byLeader := map[string]*api.Client{"a2": a2, outside: {Base: srv.URL, Token: tokOut}}
	for _, c := range []struct{ name, leader, want string }{
		{"o9 线上的负责人能改档案、解除标记", "a2", "ok"},
		{"线外的负责人改档案、解除标记被拒", outside, "forbidden"},
	} {
		for _, call := range []struct {
			path string
			body any
		}{
			{"/api/workers/edit", map[string]string{"name": "harness/fake"}},
			{"/api/workers/clear", map[string]string{"target": "fake"}},
		} {
			err := byLeader[c.leader].Do(ctx, "POST", call.path, call.body, nil)
			if got := code(err); got != c.want {
				t.Errorf("%s %s：%s，应为 %s（%v）", c.name, call.path, got, c.want, err)
			}
			var ae *api.Error
			if c.want == "forbidden" && (!errors.As(err, &ae) || !strings.Contains(ae.Message, "执行者档案") ||
				!strings.Contains(ae.Message, ProfileDept) || !strings.Contains(ae.Message, "上报") || !strings.Contains(ae.Next, "leader escalate")) {
				t.Errorf("%s %s 应说明归 %s 的负责人管、要上报：%v", c.name, call.path, ProfileDept, err)
			}
		}
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
		t.Fatalf("a2 上报应投 a1：%+v %v", out, err)
	}
	var target, kind, body string
	env.DB.QueryRowContext(ctx, `SELECT target, kind, body FROM events ORDER BY id DESC LIMIT 1`).Scan(&target, &kind, &body)
	if target != "a1" || kind != events.LeaderEscalate || !strings.Contains(body, "卡了三次") {
		t.Fatalf("上报事件：%s %s %s", target, kind, body)
	}
	hist, _ := ledger.History(ctx, env.DB, "t1", 100)
	if hist[len(hist)-1].Kind != "escalated" {
		t.Fatalf("任务经历应记上报：%+v", hist)
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
		"别处任务":     {a2, EscalateIn{Kind: "stuck", Note: "x", Task: "t2"}, "forbidden"},
		"转交别人的事件":  {a2, EscalateIn{Kind: "stuck", Note: "x", Event: 2}, "forbidden"},
		"用户不上报":    {user, EscalateIn{Kind: "stuck", Note: "x"}, "forbidden"},
		"类型不对":     {a2, EscalateIn{Kind: "help", Note: "x"}, "usage"},
		"已删除的类型":   {a2, EscalateIn{Kind: "shipped", Note: "x", Task: "t1"}, "usage"},
		"已删除的类型转交": {a1, EscalateIn{Kind: "shipped", Note: "x", Event: 1}, "usage"},
		"不存在的事件":   {a2, EscalateIn{Kind: "stuck", Note: "x", Event: 99}, "not_found"},
	} {
		if got := code(c.cl.Do(ctx, "POST", "/api/escalations", c.in, nil)); got != c.want {
			t.Errorf("%s：%s，应为 %s", name, got, c.want)
		}
	}
}

func TestNotify(t *testing.T) {
	env, h, srv := fixture(t)
	ctx := context.Background()
	tok, err := h.issue("a2")
	if err != nil {
		t.Fatal(err)
	}
	client := &api.Client{Base: srv.URL, Token: tok}
	for _, task := range []string{"", "t1"} {
		var out Escalation
		if err := client.Do(ctx, "POST", "/api/escalations", EscalateIn{Kind: "notify", Note: "将调整测试应用配置", Task: task}, &out); err != nil || out.To != org.Secretary {
			t.Fatalf("notify 应越过 a1 直达秘书：%+v %v", out, err)
		}
	}
	var target, level string
	if err := env.DB.QueryRowContext(ctx, `SELECT target, level FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1`, events.LeaderEscalate).Scan(&target, &level); err != nil {
		t.Fatal(err)
	}
	if target != org.Secretary || level != events.Act {
		t.Fatalf("秘书须能领取知会：%s %s", target, level)
	}
}

// 问用户：挂到任务上、投秘书；坏输入按参数名报错；回话清掉问题并发给负责人，负责人自己说是撤回、不发给自己。
func TestAsk(t *testing.T) {
	env, h, srv := fixture(t)
	ctx := context.Background()
	tok, _ := h.issue("a2")
	a2 := &api.Client{Base: srv.URL, Token: tok}
	var out Escalation
	if err := a2.Do(ctx, "POST", "/api/escalations", EscalateIn{Kind: "ask", Note: "logo 挑几号？", Task: "t1"}, &out); err != nil ||
		out.To != org.Secretary || out.Task != "t1" {
		t.Fatalf("ask 应直达秘书：%+v %v", out, err)
	}
	var target, level, body string
	env.DB.QueryRowContext(ctx, `SELECT target, level, body FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1`, events.LeaderEscalate).Scan(&target, &level, &body)
	if target != org.Secretary || level != events.Act || !strings.Contains(body, `"kind":"ask"`) {
		t.Fatalf("秘书须能领取问题：%s %s %s", target, level, body)
	}
	if got := events.Summary(events.Row{Kind: events.LeaderEscalate, Task: "t1", Body: []byte(body)}, nil); !strings.Contains(got, "logo 挑几号？") ||
		!strings.Contains(got, "atrium task tell t1") {
		t.Fatalf("秘书看到的一句话要带问题和回话命令：%s", got)
	}
	// 再问换成新的：一件任务同时一条。
	if err := a2.Do(ctx, "POST", "/api/escalations", EscalateIn{Kind: "ask", Note: "服务器地址和域名是？", Task: "t1"}, nil); err != nil {
		t.Fatal(err)
	}
	t1, _ := ledger.Get(ctx, env.DB, "t1")
	var n int
	env.DB.QueryRowContext(ctx, `SELECT count(*) FROM task_asks`).Scan(&n)
	if t1.Ask != "服务器地址和域名是？" || t1.AskedAt == 0 || n != 1 {
		t.Fatalf("应只挂最新一条：%q %d 条", t1.Ask, n)
	}

	must := func(_ any, err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(ledger.Add(ctx, env.DB, ledger.NewTask{Title: "已结束", Org: "o2"}, "u1")) // t3
	must(ledger.Apply(ctx, env.DB, "t3", ledger.Event{Kind: ledger.Cancel}, "u1", ""))
	must(ledger.Add(ctx, env.DB, ledger.NewTask{Title: "草稿", Org: "o2", Draft: true}, "u1")) // t4
	for name, c := range map[string]struct {
		in         EscalateIn
		code, text string
	}{
		"超长":     {EscalateIn{Kind: "ask", Note: strings.Repeat("问", ledger.MaxAsk+1), Task: "t1"}, "usage", "最多 500 字"},
		"没写任务":   {EscalateIn{Kind: "ask", Note: "x"}, "usage", "--task"},
		"已结束的任务": {EscalateIn{Kind: "ask", Note: "x", Task: "t3"}, "conflict", "已结束"},
		"草稿":     {EscalateIn{Kind: "ask", Note: "x", Task: "t4"}, "conflict", "只有待派的任务"},
		"别处任务":   {EscalateIn{Kind: "ask", Note: "x", Task: "t2"}, "forbidden", ""},
	} {
		err := a2.Do(ctx, "POST", "/api/escalations", c.in, nil)
		if code(err) != c.code || !strings.Contains(fmt.Sprint(err), c.text) {
			t.Errorf("%s：%v，应为 %s（%s）", name, err, c.code, c.text)
		}
	}

	// 秘书代用户回话：清掉问题，发给处理它的负责人 a2（t1 是用户建的，按部门找到 a2），正文带问的话。
	tell := func(by, text string) string {
		t.Helper()
		t1, _ := ledger.Get(ctx, env.DB, "t1")
		var who string
		if err := env.DB.Tx(ctx, func(tx *sql.Tx) (err error) {
			_, who, err = ledger.RecordTell(ctx, tx, t1, text, by)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return who
	}
	if who := tell(org.Secretary, "地址 10.0.0.1，域名 a.example"); who != "a2" {
		t.Fatalf("回话应发给 a2：%q", who)
	}
	env.DB.QueryRowContext(ctx, `SELECT target, body FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1`, events.TaskAssigned).Scan(&target, &body)
	if target != "a2" || !strings.Contains(body, "服务器地址和域名是？") || !strings.Contains(body, "10.0.0.1") {
		t.Fatalf("回话事件：%s %s", target, body)
	}
	if t1, _ = ledger.Get(ctx, env.DB, "t1"); t1.Ask != "" {
		t.Fatalf("回话后问题应清掉：%q", t1.Ask)
	}
	// 实际跑负责人收集与拉起：回话事件必须能使负责人醒来，不能只验证事件落库。
	f := &fakeLauncher{h: h, db: env.DB, ack: true, cmd: "exit 0"}
	SetLauncher(f.launch)
	t.Cleanup(func() { SetLauncher(nil) })
	if err := h.round(ctx, env); err != nil {
		t.Fatal(err)
	}
	h.wg.Wait()
	if f.calls.Load() != 1 {
		t.Fatalf("回话后应唤醒一次负责人，实际 %d 次", f.calls.Load())
	}
	// 负责人撤回：清掉，不发给自己。
	if err := a2.Do(ctx, "POST", "/api/escalations", EscalateIn{Kind: "ask", Note: "还要吗？", Task: "t1"}, nil); err != nil {
		t.Fatal(err)
	}
	env.DB.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE kind = ?`, events.TaskAssigned).Scan(&n)
	if who := tell("a2", "自己查到了，不用问了"); who != "" {
		t.Fatalf("撤回不发给自己：%q", who)
	}
	var after int
	env.DB.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE kind = ?`, events.TaskAssigned).Scan(&after)
	if t1, _ = ledger.Get(ctx, env.DB, "t1"); t1.Ask != "" || after != n {
		t.Fatalf("撤回：问题 %q，事件 %d → %d", t1.Ask, n, after)
	}
	// 任务离开待派时一并删掉。
	if err := a2.Do(ctx, "POST", "/api/escalations", EscalateIn{Kind: "ask", Note: "再问一次", Task: "t1"}, nil); err != nil {
		t.Fatal(err)
	}
	must(ledger.Apply(ctx, env.DB, "t1", ledger.Event{Kind: ledger.Cancel}, "u1", ""))
	if env.DB.QueryRowContext(ctx, `SELECT count(*) FROM task_asks`).Scan(&n); n != 0 {
		t.Fatalf("任务结束后问题应删掉：%d 条", n)
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
	f := &fakeLauncher{h: h, db: env.DB, ack: true, cmd: "echo 本次输出"}
	SetLauncher(f.launch)
	t.Cleanup(func() { SetLauncher(nil) })
	var segs []string
	old := WakeUsage
	WakeUsage = func(_ context.Context, _ store.Querier, profile, log string) (string, string, error) {
		segs = append(segs, log)
		return "m-" + profile, `{"currency":"USD"}`, nil
	}
	t.Cleanup(func() { WakeUsage = old })
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

	// 成功：处理完确认，令牌随即作废；提示词带部门、要点链、事件，以及没登记负责人的下属。
	if _, err := org.Add(ctx, env.DB, org.NewDept{Name: "网页", Parent: "o2"}); err != nil {
		t.Fatal(err)
	}
	events.Emit(ctx, env.DB, events.Event{Kind: events.TaskStatus, Task: "t1", Dept: "o2", Target: "a2", Level: events.Act})
	round()
	if f.calls.Load() != 1 || h.fails["a2"] != 0 {
		t.Fatalf("应唤醒一次且成功：calls=%d fails=%d", f.calls.Load(), h.fails["a2"])
	}
	l := f.seen[0]
	if tmp := filepath.Join(env.Paths.Data, "leaders", "a2", "tmp"); l.Env[platform.EnvKey(runtime.GOOS, "TMPDIR")] != tmp {
		t.Fatalf("负责人的临时目录应是自己的会话临时目录 %s：%q", tmp, l.Env[platform.EnvKey(runtime.GOOS, "TMPDIR")])
	}
	if l.Profile != "fake" || l.Env["ATRIUM_WORKER"] != "" || l.Env["ATRIUM_DATA"] != env.Paths.Data ||
		!strings.Contains(l.Prompt, "k1（o1）简洁优先") || !strings.Contains(l.Prompt, "## 用户的全局原则（~/AGENTS.md，优先于部门要点）\n\n先给结论") || !strings.Contains(l.Prompt, "#1") || !strings.Contains(l.Prompt, "发给 总部（a1）") ||
		!strings.Contains(l.Prompt, "也归你管的下属部门：o4 网页") {
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
	events.Emit(ctx, env.DB, events.Event{Kind: events.TaskStatus, Task: "t1", Dept: "o2", Target: "a2", Level: events.Act}) // #2
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

	// 每次唤醒一条记录；用量只拿这次的日志段；没拉起来的不读日志、没有用时。
	ws, err := ReadWakes(ctx, env.DB, 0)
	if err != nil {
		t.Fatal(err)
	}
	type row struct{ leader, outcome, reason, model string }
	var got []row
	for _, w := range ws {
		got = append(got, row{w.Leader, w.Outcome, w.Reason, w.Model})
		if (w.Outcome == WakeSetup) != (w.DurationMS == nil) || w.Profile != "fake" {
			t.Fatalf("用时与组合：%+v", w)
		}
	}
	want := []row{
		{"a2", WakeOK, "", "m-fake"},
		{"a2", WakeFail, "没确认 1/1 件", "m-fake"},
		{"a2", WakeFail, "没确认 1/1 件；已转交 a1", "m-fake"},
		{"a1", WakeSetup, "拉起接口还没接上（leaders.SetLauncher）", ""},
		{"a1", WakeSetup, "拉起接口还没接上（leaders.SetLauncher）", ""},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) || ws[2].N != 2 || ws[4].N != 2 || ws[0].N != 1 || ws[0].Usage != `{"currency":"USD"}` || ws[3].Usage != "{}" {
		t.Fatalf("唤醒记录：%+v", ws)
	}
	if len(segs) != 3 {
		t.Fatalf("只有拉起来的唤醒取用量：%d", len(segs))
	}
	for _, s := range segs {
		if strings.Count(s, "=== ") != 1 || !strings.Contains(s, "本次输出") {
			t.Fatalf("日志段应只含这一次唤醒：%q", s)
		}
	}

	// 用量取不到不挡记录。
	WakeUsage = func(context.Context, store.Querier, string, string) (string, string, error) {
		return "", "", errors.New("解析失败")
	}
	SetLauncher(f.launch)
	f.ack = true
	events.Emit(ctx, env.DB, events.Event{Kind: events.TaskStatus, Task: "t1", Dept: "o2", Target: "a2", Level: events.Act})
	round()
	if ws, err = ReadWakes(ctx, env.DB, 0); err != nil || len(ws) != 6 || ws[5].Outcome != WakeOK || ws[5].Usage != "{}" {
		t.Fatalf("用量取不到也要落记录：%+v %v", ws, err)
	}
}

// 转交的事务失败：事件仍归原负责人，记录写转交失败，不写「已转交」。
func TestWakeForwardFails(t *testing.T) {
	env, h, _ := fixture(t)
	ctx := context.Background()
	f := &fakeLauncher{h: h, db: env.DB}
	SetLauncher(f.launch)
	t.Cleanup(func() { SetLauncher(nil) })
	if _, err := env.DB.ExecContext(ctx, `CREATE TRIGGER no_retarget BEFORE UPDATE OF target ON events
		BEGIN SELECT RAISE(ABORT, '注入的转交失败'); END`); err != nil {
		t.Fatal(err)
	}
	events.Emit(ctx, env.DB, events.Event{Kind: events.TaskStatus, Task: "t1", Dept: "o2", Target: "a2", Level: events.Act})
	for range MaxFails {
		if err := h.round(ctx, env); err != nil {
			t.Fatal(err)
		}
		h.wg.Wait()
	}
	var target string
	if err := env.DB.QueryRowContext(ctx, `SELECT target FROM events WHERE id = 1`).Scan(&target); err != nil || target != "a2" {
		t.Fatalf("转交失败事件应仍归 a2：%q %v", target, err)
	}
	ws, err := ReadWakes(ctx, env.DB, 0)
	if err != nil || len(ws) != MaxFails {
		t.Fatalf("唤醒记录：%+v %v", ws, err)
	}
	if r := ws[MaxFails-1].Reason; ws[MaxFails-1].Outcome != WakeFail || !strings.Contains(r, "转交上一层失败：") || !strings.Contains(r, "注入的转交失败") || strings.Contains(r, "已转交") {
		t.Fatalf("转交失败的记录：%+v", ws[MaxFails-1])
	}
}

func TestWakeResult(t *testing.T) {
	boom := errors.New("超过 20m0s 没结束，已结束")
	for _, c := range []struct {
		started     bool
		err         error
		left, total int
		to          []string
		ferr        error
		out, reason string
	}{
		{false, errors.New("a2 没有登记执行者组合"), 1, 1, nil, nil, WakeSetup, "a2 没有登记执行者组合"},
		{true, nil, 0, 3, nil, nil, WakeOK, ""},
		{true, errors.New("exit status 1"), 0, 3, nil, nil, WakeOK, ""},
		{true, nil, 2, 3, nil, nil, WakeFail, "没确认 2/3 件"},
		{true, boom, 3, 3, []string{"a1", "secretary"}, nil, WakeFail, "没确认 3/3 件；超过 20m0s 没结束，已结束；已转交 a1、secretary"},
		{true, nil, 1, 1, nil, errors.New("database is locked"), WakeFail, "没确认 1/1 件；转交上一层失败：database is locked"},
	} {
		out, reason := WakeResult(c.started, c.err, c.left, c.total, c.to, c.ferr)
		if out != c.out || reason != c.reason {
			t.Errorf("%+v：得到 %s %q", c, out, reason)
		}
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
	// 知会不唤醒负责人。
	events.Emit(ctx, env.DB, events.Event{Kind: "x", Target: "a2", Level: events.Info})
	if err := h.round(ctx, env); err != nil {
		t.Fatal(err)
	}
	h.wg.Wait()
	if h.fails["a2"] != 0 || f.calls.Load() != 0 {
		t.Fatalf("知会不该唤醒：fails=%d", h.fails["a2"])
	}
	events.Emit(ctx, env.DB, events.Event{Kind: "y", Target: "a2", Level: events.Act})
	start := time.Now()
	if err := h.round(ctx, env); err != nil {
		t.Fatal(err)
	}
	h.wg.Wait()
	if time.Since(start) > 5*time.Second || h.fails["a2"] != 1 {
		t.Fatalf("超时应结束并记失败：%s fails=%d", time.Since(start), h.fails["a2"])
	}
}

// 唤醒循环一起来就删过期记录；ReadWakes 只读 since 之后的，清理没跑到也不多算。
func TestWakeRetention(t *testing.T) {
	env, h, _ := fixture(t)
	t.Setenv("ATRIUM_LEADER_WAKE", "1")
	ctx := context.Background()
	now := store.Now()
	edge := now - WakeRetention.Milliseconds()
	for i, at := range []int64{edge - 1000, edge + 60_000, now} {
		if err := recordWake(ctx, env.DB, Wake{Leader: "a2", Profile: "fake", N: 1, Outcome: WakeOK, At: at}); err != nil {
			t.Fatal(i, err)
		}
	}
	if ws, err := ReadWakes(ctx, env.DB, edge); err != nil || len(ws) != 2 || ws[0].At != edge+60_000 {
		t.Fatalf("只读保留期内：%+v %v", ws, err)
	}
	if ws, _ := ReadWakes(ctx, env.DB, 0); len(ws) != 3 {
		t.Fatalf("清理前三条都在：%d", len(ws))
	}
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- h.run(runCtx, env) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		ws, err := ReadWakes(ctx, env.DB, 0)
		if err != nil {
			t.Fatal(err)
		}
		if len(ws) == 2 && ws[0].At == edge+60_000 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("唤醒循环应删掉过期记录：%+v", ws)
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestWakeEnabled(t *testing.T) {
	def, _ := config.Resolve(func(string) string { return "" })
	env := func(v string) func(string) string { return func(string) string { return v } }
	if !wakeEnabled(def.Data, env("")) || wakeEnabled(t.TempDir(), env("")) || !wakeEnabled(t.TempDir(), env("1")) {
		t.Fatal("只在缺省数据目录或 ATRIUM_LEADER_WAKE=1 时唤醒")
	}
}

// 隔离 HTTP 实例，执行真实 CLI 解析、负责人认证、上报与秘书领取。
func TestNotifyCLI(t *testing.T) {
	env, h, srv := fixture(t)
	ctx := context.Background()
	tok, err := h.issue("a2")
	if err != nil {
		t.Fatal(err)
	}
	if err := config.WriteService(env.Paths, config.ServiceInfo{PID: 1, Port: srv.Listener.Addr().(*net.TCPAddr).Port}); err != nil {
		t.Fatal(err)
	}
	tb := cli.NewTable("atrium", "隔离验证")
	tb.Group("leader", "负责人")
	commands(tb)
	events.Commands(tb)
	vars := map[string]string{"ATRIUM_DATA": env.Paths.Data, "ATRIUM_LEADER_TOKEN": tok}
	run := func(args ...string) (int, string) {
		var output bytes.Buffer
		code := tb.Main(ctx, args, cli.Env{Stdout: &output, Stderr: &output, Getenv: func(k string) string { return vars[k] }})
		t.Logf("atrium %s\n%s", strings.Join(args, " "), output.String())
		return code, output.String()
	}
	code, output := run("leader", "escalate", "将调整测试应用配置", "--kind", "notify", "--task", "t1", "--json")
	if code != 0 || !strings.Contains(output, `"to":"secretary"`) {
		t.Fatalf("notify: %d %s", code, output)
	}
	// 切到隔离用户令牌，以秘书订阅领取。
	if err := os.WriteFile(env.Paths.Token(), []byte("user"), 0600); err != nil {
		t.Fatal(err)
	}
	delete(vars, "ATRIUM_LEADER_TOKEN")
	code, output = run("events", "wait", "--as", "secretary", "--timeout", "0", "--json")
	if code != 0 {
		t.Fatalf("秘书领取：%d %s", code, output)
	}
	var receipt struct{ Result []events.Row }
	if err := json.Unmarshal([]byte(output), &receipt); err != nil {
		t.Fatal(err)
	}
	if len(receipt.Result) != 1 || receipt.Result[0].Target != org.Secretary || !strings.Contains(string(receipt.Result[0].Body), "notify") {
		t.Fatalf("秘书应收到 notify：%s", output)
	}
	vars["ATRIUM_LEADER_TOKEN"] = tok
	code, output = run("leader", "escalate", "非法类型", "--kind", "help", "--json")
	if code == 0 || !strings.Contains(output, `"code":"usage"`) {
		t.Fatalf("非法 kind 未拒绝：%d %s", code, output)
	}
}
