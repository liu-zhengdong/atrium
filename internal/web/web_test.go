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
		{ledger.Task{Status: ledger.Running, Stage: ledger.StageAccept}, 2, "run", "等验收"},
		{ledger.Task{Status: ledger.Running, Stage: ledger.StageMerge}, 3, "run", "合入队列"},
		{ledger.Task{Status: ledger.Running, Stage: ledger.StageMerged}, 4, "run", "等发版"},
		{ledger.Task{Status: ledger.Done, Stage: ledger.StageReleased}, 5, "done", "已上线"},
		{ledger.Task{Status: ledger.Done}, 5, "done", "完成"},
		{ledger.Task{Status: ledger.Blocked, PR: "#1"}, 2, "bad", "卡住"},
		{ledger.Task{Status: ledger.Failed, Worker: "x"}, 1, "bad", "失败"},
		{ledger.Task{Status: ledger.Cancelled}, 0, "off", "取消"},
	}
	for _, c := range cases {
		if step(c.t) != c.step || state(c.t) != c.state || who(c.t, nil) != c.who {
			t.Errorf("%s/%s：step %d state %s who %s", c.t.Status, c.t.Stage, step(c.t), state(c.t), who(c.t, nil))
		}
	}
	// 没派的写在等谁；别的状态有依赖也不写（排队、在做说明依赖已经完成）。
	waits := []struct {
		status  ledger.Status
		waiting []string
		who     string
	}{
		{ledger.Todo, []string{"t7"}, "等 t7"},
		{ledger.Todo, []string{"t7", "t9"}, "等 t7、t9"},
		{ledger.Todo, []string{"t7", "t9", "t12"}, "等 3 件"},
		{ledger.Queued, []string{"t7"}, "排队"},
		{ledger.Draft, []string{"t7"}, ""},
	}
	for _, c := range waits {
		if got := who(ledger.Task{Status: c.status}, c.waiting); got != c.who {
			t.Errorf("%s 等 %v：得到 %q，应为 %q", c.status, c.waiting, got, c.who)
		}
	}
}

func TestNest(t *testing.T) {
	task := func(id, parent string, created int64) ledger.Task {
		return ledger.Task{ID: id, Parent: parent, CreatedAt: created}
	}
	// 列表按最近变化排：子任务可能排在父任务前面；父任务不在列表里的自成一棵；同一毫秒建的按短号数字（t3 在 t10 前）。
	tasks := []ledger.Task{task("t5", "t1", 5), task("t1", "", 1), task("t10", "t1", 3), task("t3", "t1", 3), task("t9", "t8", 9), task("t6", "t5", 6), task("t2", "", 2)}
	rows := make([]Row, len(tasks))
	for i, x := range tasks {
		rows[i] = Row{ID: x.ID}
	}
	var shape func(rs []Row) string
	shape = func(rs []Row) string {
		var parts []string
		for _, r := range rs {
			p := r.ID
			if len(r.Kids) > 0 {
				p += "(" + shape(r.Kids) + ")"
			}
			parts = append(parts, p)
		}
		return strings.Join(parts, " ")
	}
	if got, want := shape(nest(tasks, rows)), "t1(t3 t10 t5(t6)) t9 t2"; got != want {
		t.Errorf("得到 %s，应为 %s", got, want)
	}
	if got := nest(nil, nil); len(got) != 0 {
		t.Errorf("空列表：%v", got)
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
	if page.Leader == nil || page.Leader.Name != "运行时负责人" || page.Leader.Inherited {
		t.Errorf("负责人：%+v", page.Leader)
	}
	// 自己没有负责人：显示往上最近一级的，标成继承；上面一路都没有就是空（你直接管）。
	leaf, _ := org.Add(ctx, db, org.NewDept{Name: "网页", Parent: sub.ID})
	read("dept/"+leaf.ID, &page)
	if page.Leader == nil || page.Leader.ID != a.ID || !page.Leader.Inherited {
		t.Errorf("继承的负责人：%+v", page.Leader)
	}
	page = DeptPage{}
	read("dept/"+root.ID, &page)
	if page.Leader != nil {
		t.Errorf("上面没有负责人时应为空：%+v", page.Leader)
	}
	if res := get("/", ""); res.StatusCode != 200 || !strings.Contains(res.Header.Get("Content-Security-Policy"), "script-src") && !strings.Contains(res.Header.Get("Content-Security-Policy"), "default-src 'self'") {
		t.Errorf("首页：%d", res.StatusCode)
	}
}

// 等你验收：只列验收人是你的；负责人验收的归负责人。
func TestAsksAccept(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mine, _ := org.Add(ctx, db, org.NewDept{Name: "哆啦美"})
	theirs, _ := org.Add(ctx, db, org.NewDept{Name: "管家"})
	user, leader := org.AcceptUser, org.AcceptLeader
	org.Edit(ctx, db, mine.ID, org.DeptPatch{Accept: &user})
	org.Edit(ctx, db, theirs.ID, org.DeptPatch{Accept: &leader})
	waiting := func(dept, by string) string {
		task, _ := ledger.Add(ctx, db, ledger.NewTask{Title: "交付", Org: dept}, "u1")
		for _, ev := range []ledger.Event{{Kind: ledger.Enqueue}, {Kind: ledger.Start}, {Kind: ledger.ExitOK}, {Kind: ledger.GatePass, AcceptBy: by}} {
			if _, err := ledger.Apply(ctx, db, task.ID, ev, "runtime", ""); err != nil {
				t.Fatal(err)
			}
		}
		return task.ID
	}
	id := waiting(mine.ID, user)
	waiting(theirs.ID, leader)
	ix, err := loadOrg(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	asks, err := loadAsks(ctx, db, ix)
	if err != nil || len(asks) != 1 || asks[0].Kind != "accept" || asks[0].ID != id || asks[0].DeptName != "哆啦美" {
		t.Fatalf("等你验收：%+v %v", asks, err)
	}
}

// 部门页把目标和它拆出的子任务排成树，已结束多久的子任务都挂上；抽屉给上级、子任务、要等的、在等它的。
func TestTaskTree(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	root, _ := org.Add(ctx, db, org.NewDept{Name: "组织"})
	web, _ := org.Add(ctx, db, org.NewDept{Name: "网页", Parent: root.ID})
	other, _ := org.Add(ctx, db, org.NewDept{Name: "运行时", Parent: root.ID})
	add := func(title, dept, parent string, after ...string) ledger.Task {
		x, err := ledger.Add(ctx, db, ledger.NewTask{Title: title, Org: dept, Parent: parent, After: after}, "u1")
		if err != nil {
			t.Fatal(err)
		}
		return x
	}
	iface := add("接口", other.ID, "")
	goal := add("目标", web.ID, "")
	a := add("第一件", web.ID, goal.ID)
	b := add("第二件", web.ID, goal.ID, a.ID, iface.ID)
	c := add("第二件的一半", other.ID, b.ID) // 子任务在别的部门，也挂在目标下
	old := add("早就做完的", web.ID, goal.ID)
	if _, err := ledger.Apply(ctx, db, old.ID, ledger.Event{Kind: ledger.Set, To: ledger.Done}, "u1", ""); err != nil {
		t.Fatal(err)
	}
	db.ExecContext(ctx, `UPDATE tasks SET finished_at = 1 WHERE id = ?`, old.ID) // 早于三天，本身不进列表

	page, err := loadDept(ctx, db, t.TempDir(), web.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Tasks) != 1 || page.Tasks[0].ID != goal.ID {
		t.Fatalf("部门页应只有一棵以目标为根的树：%+v", page.Tasks)
	}
	kids := page.Tasks[0].Kids
	if len(kids) != 3 || kids[0].ID != a.ID || kids[1].ID != b.ID || kids[2].ID != old.ID || kids[2].State != "done" {
		t.Fatalf("子任务按建立先后，含早就结束的：%+v", kids)
	}
	if kids[1].Who != "等 "+iface.ID+"、"+a.ID || len(kids[1].Kids) != 1 || kids[1].Kids[0].ID != c.ID {
		t.Errorf("第二件等两件、下面挂着别的部门的一半：%+v", kids[1])
	}

	d, err := loadTask(ctx, db, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	ids := func(rs []Row) (out []string) {
		for _, r := range rs {
			out = append(out, r.ID)
		}
		return out
	}
	if d.Parent == nil || d.Parent.ID != goal.ID || !reflect.DeepEqual(ids(d.Kids), []string{c.ID}) ||
		!reflect.DeepEqual(ids(d.Waits), []string{iface.ID, a.ID}) || len(d.Waiters) != 0 {
		t.Errorf("第二件的抽屉：%+v", d)
	}
	d, err = loadTask(ctx, db, iface.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.Parent != nil || len(d.Kids) != 0 || len(d.Waits) != 0 || !reflect.DeepEqual(ids(d.Waiters), []string{b.ID}) {
		t.Errorf("接口的抽屉：%+v", d)
	}
}
