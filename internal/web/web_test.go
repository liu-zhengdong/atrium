package web

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func TestLocalHost(t *testing.T) {
	cases := []struct {
		host string
		ok   bool
	}{
		{"127.0.0.1:4320", true},
		{"localhost:4320", true},
		{"LOCALHOST:4320", true},
		{"evil.example:4320", false}, // DNS 重绑定：解析到 127.0.0.1 的外部域名
		{"127.0.0.1.evil.example:4320", false},
		{"127.0.0.1:9999", false},
		{"127.0.0.1", false},
		{"[::1]:4320", false}, // 服务只听 127.0.0.1
		{"", false},
	}
	for _, c := range cases {
		if got := localHost(c.host, 4320); got != c.ok {
			t.Errorf("%q：得到 %v", c.host, got)
		}
	}
}

func TestStepHolder(t *testing.T) {
	cases := []struct {
		t          ledger.Task
		step       int
		state, who string
	}{
		{ledger.Task{Status: ledger.Todo}, 0, "idle", "没派"},
		{ledger.Task{Status: ledger.Queued}, 0, "idle", "排队"},
		{ledger.Task{Status: ledger.Running, Worker: "claude+opus:high", Host: "h1"}, 1, "run", "claude · h1"},
		{ledger.Task{Status: ledger.Running}, 1, "run", "在做"},
		{ledger.Task{Status: ledger.Running, Stage: ledger.StageGate}, 2, "run", "验收中"},
		{ledger.Task{Status: ledger.Running, Stage: ledger.StageReview}, 2, "run", "审阅中"},
		{ledger.Task{Status: ledger.Running, Stage: ledger.StageMerge}, 3, "run", "合入队列"},
		{ledger.Task{Status: ledger.Running, Stage: ledger.StageMerged}, 4, "run", "等发版"},
		{ledger.Task{Status: ledger.Done, Stage: ledger.StageReleased}, 5, "done", "已上线"},
		{ledger.Task{Status: ledger.Done}, 5, "done", "完成"},
		{ledger.Task{Status: ledger.Blocked, PR: "#1"}, 2, "bad", "卡住"},
		{ledger.Task{Status: ledger.Failed, Worker: "x"}, 1, "bad", "失败"},
		{ledger.Task{Status: ledger.Cancelled}, 0, "off", "取消"},
	}
	for _, c := range cases {
		if step(c.t) != c.step || state(c.t) != c.state || who(c.t) != c.who {
			t.Errorf("%s/%s：step %d state %s who %s", c.t.Status, c.t.Stage, step(c.t), state(c.t), who(c.t))
		}
	}
}

func TestAccountAndSlots(t *testing.T) {
	used, reset := 37.6, 30.0
	a := account(quota.Line{Pace: quota.Pace{Account: "claude", UsedPercent: &used, HoursToReset: &reset}}, 0)
	if a.Left == nil || *a.Left != 62 || a.Note != "1 天后重置" {
		t.Errorf("有读数：%+v %v", a, *a.Left)
	}
	a = account(quota.Line{Pace: quota.Pace{Account: "codex"}, Note: "没登录"}, 0)
	if a.Left != nil || a.Note != "没登录" {
		t.Errorf("没读数：%+v", a)
	}
	a = account(quota.Line{Pace: quota.Pace{Account: "x", UsedPercent: &used, Stale: true}, Hold: &quota.Hold{Until: 10}}, 5)
	if a.Note != "用尽，暂不派 · 读数旧了" {
		t.Errorf("用尽：%q", a.Note)
	}
	for want, h := range map[int]hosts.Host{4: {MaxRunning: 4, Info: &hosts.Info{MaxWorkers: 6}}, 6: {Info: &hosts.Info{MaxWorkers: 6}}, 1: {}} {
		if got := slots(h); got != want {
			t.Errorf("空位：%d 想要 %d", got, want)
		}
	}
}

func TestTopGroup(t *testing.T) {
	parents := map[string]string{"o1": "", "o2": "o1", "o5": "o2", "o8": "o5", "o9": ""}
	for id, want := range map[string]string{"o1": "o1", "o2": "o2", "o5": "o2", "o8": "o2", "o9": "o9"} {
		if got := topGroup(parents, id); got != want {
			t.Errorf("%s：得到 %s 想要 %s", id, got, want)
		}
	}
}

func TestBrowserInvocation(t *testing.T) {
	for goos, cmd := range map[string]string{"darwin": "open", "linux": "xdg-open", "windows": "rundll32"} {
		inv := browserInvocation(goos, "http://x")
		if inv.Command != cmd || inv.Args[len(inv.Args)-1] != "http://x" {
			t.Errorf("%s：%+v", goos, inv)
		}
	}
}

// 整条路径：不登录直接读接口；外来 Host 一律 403，不带 CORS 头。
func TestRoutes(t *testing.T) {
	// 额度读取不碰开发者本机的登录与 OpenQuota。
	t.Setenv("ATRIUM_QUOTA_READERS", "off")
	t.Setenv("ATRIUM_OPENQUOTA_BIN", filepath.Join(t.TempDir(), "no-openquota"))
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	root, err := org.Add(ctx, db, org.NewDept{Name: "组织"})
	if err != nil {
		t.Fatal(err)
	}
	sub, _ := org.Add(ctx, db, org.NewDept{Name: "运行时", Parent: root.ID})
	org.AddPoint(ctx, db, root.ID, org.NewPoint{Text: "简洁优先"}, "u1")
	task, _ := ledger.Add(ctx, db, ledger.NewTask{Title: "卡住的活", Org: sub.ID}, "u1")
	if _, err := ledger.Apply(ctx, db, task.ID, ledger.Event{Kind: ledger.Block}, "a1", "等你拍板"); err != nil {
		t.Fatal(err)
	}

	r := api.NewRouter(slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.AddAuth(func(tok string) (api.Actor, bool) { return api.Actor{ID: "u1", Kind: "user"}, tok == "secret" })
	srv := httptest.NewServer(r)
	defer srv.Close()
	port, _ := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	m := Module()
	m.Routes(r, &app.Env{DB: db, Port: port, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})

	get := func(path, host string) *http.Response {
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		req.Header.Set("Origin", "http://evil.example")
		if host != "" {
			req.Host = host
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	for _, path := range []string{"/", "/ui/api/today", "/ui/stream", "/ui/assets/app.js"} {
		res := get(path, "evil.example:"+strconv.Itoa(port))
		res.Body.Close()
		if res.StatusCode != 403 {
			t.Errorf("%s 外来 Host 应 403，得到 %d", path, res.StatusCode)
		}
	}
	if res := get("/ui/api/today", ""); res.StatusCode != 200 || res.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("本机 Host 不登录应 200 且无 CORS 头：%d %q", res.StatusCode, res.Header.Get("Access-Control-Allow-Origin"))
	}
	if res := get("/ui/api/dept/..", ""); res.StatusCode == 200 {
		t.Error("路径穿越不该 200")
	}
	read := func(path string, out any) {
		res := get("/ui/api/"+path, "")
		defer res.Body.Close()
		var env struct {
			OK     bool            `json:"ok"`
			Result json.RawMessage `json:"result"`
		}
		if err := json.NewDecoder(res.Body).Decode(&env); err != nil || !env.OK {
			t.Fatalf("%s：%d %v", path, res.StatusCode, err)
		}
		json.Unmarshal(env.Result, out)
	}
	var today Today
	read("today", &today)
	if len(today.Asks) != 1 || today.Asks[0].ID != task.ID || today.Asks[0].Sub != "等你拍板" || today.Asks[0].DeptName != "运行时" {
		t.Errorf("今天：%+v", today.Asks)
	}
	var page DeptPage
	read("dept/"+sub.ID, &page)
	if len(page.Tasks) != 1 || page.Tasks[0].State != "bad" || len(page.Inherited) != 1 || !reflect.DeepEqual(page.Path, []Pair{{root.ID, "组织"}}) {
		t.Errorf("部门：%+v", page)
	}
	var nav Nav
	read("nav", &nav)
	if len(nav.Depts) != 2 || nav.Depts[0].Stuck != 1 || nav.Asks != 1 {
		t.Errorf("侧栏：%+v", nav)
	}
	var detail TaskDetail
	read("task/"+task.ID, &detail)
	if detail.State != "bad" || detail.Trace != nil {
		t.Errorf("没拉起过执行者，日志应为空：%+v", detail)
	}
	// 抽屉的经过来自执行者进程的真日志（与 task log 同一份解析），不是任务经历。
	logFile := filepath.Join(t.TempDir(), "run-1.log")
	os.WriteFile(logFile, []byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"改好了"}]}}`+"\n"), 0o600)
	run, _ := json.Marshal(workers.Run{N: 1, Worker: "claude", Log: logFile})
	ledger.Record(ctx, db, task.ID, workers.RunKind, "dispatch", string(run))
	read("task/"+task.ID, &detail)
	if detail.Trace == nil || len(detail.Trace.Segments) != 1 || detail.Trace.Segments[0].Say != "改好了" || detail.Live {
		t.Errorf("经过：%+v", detail.Trace)
	}
	var legion Legion
	read("legion", &legion)
	if legion.Accounts == nil || legion.Hosts == nil {
		t.Error("空的额度与机器应是空数组，不是 null")
	}
	// 部门有了负责人，卡住的活先归负责人，不再递到「等你」；详情里持球人是负责人。
	a, err := org.AddLeader(ctx, db, org.NewLeader{Name: "运行时负责人", Workers: []string{"claude"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := org.Edit(ctx, db, sub.ID, org.DeptPatch{Leader: &a.ID}); err != nil {
		t.Fatal(err)
	}
	read("today", &today)
	if len(today.Asks) != 0 {
		t.Errorf("有负责人时不该递到等你：%+v", today.Asks)
	}
	// 负责人上交到秘书这层、还没确认的，进「等你」。
	events.Emit(ctx, db, events.Event{Kind: events.LeaderEscalate, Task: task.ID, Dept: sub.ID, Target: org.Secretary,
		Body: map[string]any{"from": a.ID, "label": "搞不定", "note": "证书要你签"}})
	read("today", &today)
	if len(today.Asks) != 1 || today.Asks[0].Kind != "escalate" || today.Asks[0].Title != "证书要你签" || today.Asks[0].ID != task.ID {
		t.Errorf("上交应进等你：%+v", today.Asks)
	}
	read("dept/"+sub.ID, &page)
	if page.Leader == nil || page.Leader.Name != "运行时负责人" {
		t.Errorf("负责人：%+v", page.Leader)
	}
	if res := get("/", ""); res.StatusCode != 200 || !strings.Contains(res.Header.Get("Content-Security-Policy"), "script-src") && !strings.Contains(res.Header.Get("Content-Security-Policy"), "default-src 'self'") {
		t.Errorf("首页：%d", res.StatusCode)
	}
}
