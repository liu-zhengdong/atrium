package web

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
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
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/watch"
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
	// 行首行尾都取 watch.HolderOf 的结果，这里的事实按列表行给的来（行尾不看负责人）。
	of := func(f watch.Facts) watch.Holder { return watch.HolderOf(f) }
	cases := []struct {
		t          ledger.Task
		step       int
		state, who string
	}{
		{ledger.Task{Status: ledger.Todo}, 0, "idle", "没派"},
		{ledger.Task{Status: ledger.Queued}, 0, "idle", "排队"},
		{ledger.Task{Status: ledger.Running, Worker: "claude+opus:high", Host: "h1"}, 1, "run", "claude"},
		{ledger.Task{Status: ledger.Running}, 1, "run", "在做"},
		{ledger.Task{Status: ledger.Running, Stage: ledger.StageGate}, 2, "run", "验收中"},
		{ledger.Task{Status: ledger.Running, Stage: ledger.StageReview}, 2, "run", "审阅中"},
		{ledger.Task{Status: ledger.Running, Stage: ledger.StageAccept}, 2, "run", "等验收"},
		{ledger.Task{Repo: "o/r", Status: ledger.Running, Stage: ledger.StageMerge}, 3, "run", "合入队列"},
		{ledger.Task{Repo: "o/r", Status: ledger.Running, Stage: ledger.StageMerged}, 4, "run", "等发版"},
		{ledger.Task{Repo: "o/r", Status: ledger.Done, Stage: ledger.StageReleased}, 5, "done", "已上线"},
		{ledger.Task{Status: ledger.Done}, 3, "done", "完成"}, // 没有仓库的只到验收，三步走完
		{ledger.Task{Status: ledger.Done, Repo: "o/r"}, 5, "done", "完成"},
		{ledger.Task{Status: ledger.Blocked, PR: "#1"}, 2, "bad", "卡住"},
		{ledger.Task{Status: ledger.Failed, Worker: "x"}, 1, "bad", "失败"},
		{ledger.Task{Status: ledger.Cancelled}, 0, "off", "取消"},
		{ledger.Task{Status: ledger.Draft}, 0, "draft", ""}, // 草稿自成一组，组名已说明
	}
	for _, c := range cases {
		h := of(watch.Facts{Task: c.t})
		if step(c.t) != c.step || state(c.t, h) != c.state || who(c.t, h) != c.who {
			t.Errorf("%s/%s：step %d state %s who %s", c.t.Status, c.t.Stage, step(c.t), state(c.t, h), who(c.t, h))
		}
	}
	if n, m := len(stepsOf(ledger.Task{Dir: "/x"})), len(stepsOf(ledger.Task{Repo: "o/r"})); n != 3 || m != 5 {
		t.Errorf("没有仓库的应只到验收：%d 步，有仓库的 %d 步", n, m)
	}
	// 待派的：依赖先于子任务（依赖没好不会拆着做）；拆成子任务在做的行首算在做。
	dep := func(id string, s ledger.Status) ledger.DepState { return ledger.DepState{ID: id, Status: s} }
	run7, run9, run12 := dep("t7", ledger.Running), dep("t9", ledger.Todo), dep("t12", ledger.Blocked)
	waits := []struct {
		status     ledger.Status
		deps       []ledger.DepState
		open, all  int
		state, who string
	}{
		{ledger.Todo, []ledger.DepState{run7}, 0, 0, "idle", "等 t7"},
		{ledger.Todo, []ledger.DepState{run7, dep("t8", ledger.Done), run9}, 0, 0, "idle", "等 t7、t9"},
		{ledger.Todo, []ledger.DepState{run7, run9, run12}, 0, 0, "idle", "等 3 件"},
		{ledger.Todo, []ledger.DepState{dep("t8", ledger.Done)}, 0, 0, "idle", "没派"},
		{ledger.Todo, []ledger.DepState{dep("t6", ledger.Cancelled), dep("t8", ledger.Done)}, 0, 0, "idle", "依赖的 t6 已取消"},
		{ledger.Todo, []ledger.DepState{dep("t6", ledger.Cancelled), dep("t5", ledger.Failed), run7}, 0, 0, "idle", "2 件依赖等不到了"},
		{ledger.Todo, nil, 1, 4, "run", "子任务 3/4 结束"},
		{ledger.Todo, nil, 0, 4, "idle", "等安排"},
		{ledger.Todo, []ledger.DepState{run7}, 1, 4, "idle", "等 t7"},
		{ledger.Queued, []ledger.DepState{run7}, 0, 0, "idle", "等 t7"},
		{ledger.Queued, []ledger.DepState{dep("t8", ledger.Done)}, 0, 0, "idle", "排队"},
	}
	for _, c := range waits {
		x := ledger.Task{Status: c.status}
		h := of(watch.Facts{Task: x, Deps: c.deps, OpenChildren: c.open, Children: c.all})
		if st, got := state(x, h), who(x, h); st != c.state || got != c.who {
			t.Errorf("%s 依赖 %v 子任务 %d/%d：得到 %s %q，应为 %s %q", c.status, c.deps, c.open, c.all, st, got, c.state, c.who)
		}
	}
}

func TestUsageText(t *testing.T) {
	if s := usageText(workers.Usage{}); s != "" {
		t.Errorf("四项都读不到应不给：%q", s)
	}
	n := int64(12)
	if s := usageText(workers.Usage{Tokens: workers.Tokens{Output: &n}}); !strings.Contains(s, "输出 12") {
		t.Errorf("读到一项应照常给：%q", s)
	}
}

func TestCountKids(t *testing.T) {
	tasks := []ledger.Task{
		{ID: "t1", Status: ledger.Todo},
		{ID: "t2", Parent: "t1", Status: ledger.Running},
		{ID: "t3", Parent: "t1", Status: ledger.Done},
		{ID: "t4", Parent: "t1", Status: ledger.Failed},
		{ID: "t5", Parent: "t2", Status: ledger.Todo},
	}
	got := countKids(tasks)
	want := map[string]kidCount{"t1": {open: 1, all: 3}, "t2": {open: 1, all: 1}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("得到 %+v，应为 %+v", got, want)
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

func TestSlots(t *testing.T) {
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
	// 数据目录是临时的（隔离实例）：额度不碰开发者本机的登录与 OpenQuota。
	ctx := context.Background()
	data := t.TempDir()
	db, err := store.Open(filepath.Join(data, "atrium.db"))
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
	m.Routes(r, &app.Env{DB: db, Paths: config.Paths{Data: data}, Port: port, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})

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
	for _, path := range []string{"/", "/ui/api/today", "/ui/api/worker?name=claude", "/ui/stream", "/ui/assets/app.js"} {
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
	if !strings.HasPrefix(today.Goals.Week.Text, "纠正 0（") || !strings.HasPrefix(today.Goals.All.Text, "纠正 0（") {
		t.Errorf("今天页要带三个目标的数：%+v", today.Goals)
	}
	var page DeptPage
	read("dept/"+sub.ID, &page)
	if len(page.Tasks) != 1 || page.Tasks[0].State != "bad" || len(page.Inherited) != 1 {
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
	if legion.Hosts == nil || len(legion.Workers) != len(workers.Tools) {
		t.Errorf("空的机器应是空数组，不是 null；还没结果的拉起不计：%+v", legion)
	}
	// 表现与 atrium workers 同一份统计（workers.Stats）：拉起有了结果才计；不可用标记挂在它挡住的组合下。
	exit, _ := json.Marshal(workers.Exit{N: 1, Outcome: workers.OutOK})
	ledger.Record(ctx, db, task.ID, workers.ExitKind, "dispatch", string(exit))
	// 机器暂停了，卡片上看得出（暂停范围按短号记，页面写机器名）。
	if err := hosts.EnsureLocal(ctx, db, hosts.Info{}); err != nil {
		t.Fatal(err)
	}
	ps := &pause.Store{DB: db}
	ps.Set(ctx, "h1", "u1")
	read("legion", &legion)
	if len(legion.Hosts) != 1 || !legion.Hosts[0].Paused || legion.Hosts[0].Name != "本机" {
		t.Errorf("暂停的机器：%+v", legion.Hosts)
	}
	ps.Clear(ctx, "h1")
	workers.SetMark(ctx, db, workers.Mark{Tool: "claude", Host: "h1", Kind: workers.SignalSetup, Reason: "没登录", Since: store.Now()})
	read("legion", &legion)
	// 裸名 claude 的拉起按目录组合名归并进 claude+opus，不再拆出「不在目录里」的一行；目录行数不变。
	if len(legion.Workers) != len(workers.Tools) || legion.Window != workers.StatWindow {
		t.Fatalf("表现：%+v", legion)
	}
	var p workers.Row
	for _, w := range legion.Workers {
		if w.ID == "claude+opus" {
			p = w
		}
	}
	if p.ID == "" || !reflect.DeepEqual(p.Recent, []string{workers.OutOK}) || p.Stat.OK != 1 || p.Stat.Launches != 1 ||
		len(p.Marks) != 1 || p.Marks[0].Host != "h1" {
		t.Errorf("表现一行：%+v", p)
	}
	wantRows, err := workers.List(ctx, db)
	if err != nil || !reflect.DeepEqual(legion.Workers, wantRows) {
		t.Fatalf("目录必须共用 workers.List: %v", err)
	}
	source := "---\ntrust: high\n---\n档案正文"
	if _, err := workers.SaveProfile(ctx, db, "harness/claude", workers.Edit{Source: &source}, "u1"); err != nil {
		t.Fatal(err)
	}
	var worker workers.Detail
	read("worker?name=claude", &worker)
	wantDetail, err := workers.Show(ctx, db, "claude")
	gotJSON, _ := json.Marshal(worker)
	wantJSON, _ := json.Marshal(wantDetail)
	if err != nil || string(gotJSON) != string(wantJSON) || len(worker.Layers) != 1 || worker.Trust != "high" {
		t.Fatalf("档案必须共用 workers.Show: %v", err)
	}
	read("worker?name=opencode%2Bopencode-go%2Fmimo-v2.6-flash", &worker)
	if worker.Resolved.ID != "opencode+opencode-go/mimo-v2.6-flash" {
		t.Fatalf("模型中的 / 必须保留：%+v", worker)
	}
	for _, name := range []string{"", "../bad", "no-such-tool"} {
		res := get("/ui/api/worker?name="+name, "")
		res.Body.Close()
		if res.StatusCode == http.StatusOK {
			t.Errorf("非法组合 %q 不该成功", name)
		}
	}
	// 等人处理的不可用标记进「等你」，解除就消失；额度用尽会自己恢复，不进。
	workers.SetMark(ctx, db, workers.Mark{Tool: "kimi", Host: "h3", Kind: workers.SignalQuota, Reason: "额度用尽", Since: store.Now(), Until: store.Now() + 3600_000})
	read("today", &today)
	if n := len(today.Asks); n != 2 || today.Asks[1].Kind != "worker" || today.Asks[1].Title != "claude（本机）没登录" ||
		today.Asks[1].Sub != "登录或装好运行环境后 atrium workers edit --clear claude@h1" {
		t.Errorf("不可用标记应进等你（跟在卡住的活后面）：%+v", today.Asks)
	}
	if nav, err := loadNav(ctx, db); err != nil || nav.Asks != 2 {
		t.Errorf("侧栏件数：%+v %v", nav, err)
	}
	workers.ClearMarks(ctx, db, "claude@h1")
	// 部门有了负责人，卡住的活先归负责人，不再递到「等你」；详情里当前等待对象是负责人。
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
	// notify 不进「等你」，由秘书转告。
	events.Emit(ctx, db, events.Event{Kind: events.LeaderEscalate, Target: org.Secretary,
		Body: map[string]any{"from": a.ID, "kind": "notify", "note": "将调整应用配置"}})
	read("today", &today)
	if len(today.Asks) != 0 {
		t.Fatalf("知会不应待拍板：%+v", today.Asks)
	}
	// 负责人在问用户的任务进「等你」（标题、问的话、问的时刻）；投秘书的那条 ask 上报不再重复列；任务结束后消失。
	asking, err := ledger.Add(ctx, db, ledger.NewTask{Title: "logo 定稿", Org: sub.ID}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Tx(ctx, func(tx *sql.Tx) error { return ledger.SetAsk(ctx, tx, asking.ID, "挑几号？") }); err != nil {
		t.Fatal(err)
	}
	events.Emit(ctx, db, events.Event{Kind: events.LeaderEscalate, Task: asking.ID, Dept: sub.ID, Target: org.Secretary,
		Body: map[string]any{"from": a.ID, "kind": "ask", "note": "挑几号？"}})
	read("today", &today)
	if len(today.Asks) != 1 || today.Asks[0].Kind != "reply" || today.Asks[0].ID != asking.ID || today.Asks[0].Title != "logo 定稿" ||
		today.Asks[0].Sub != "挑几号？" || today.Asks[0].At == 0 {
		t.Fatalf("在问用户的任务应进等你、只列一次：%+v", today.Asks)
	}
	if _, err := ledger.Apply(ctx, db, asking.ID, ledger.Event{Kind: ledger.Cancel}, "u1", ""); err != nil {
		t.Fatal(err)
	}
	read("today", &today)
	if len(today.Asks) != 0 {
		t.Fatalf("任务结束后不再等回话：%+v", today.Asks)
	}
	// 负责人上报到秘书这层、还没确认的，进「等你」。
	events.Emit(ctx, db, events.Event{Kind: events.LeaderEscalate, Task: task.ID, Dept: sub.ID, Target: org.Secretary,
		Body: map[string]any{"from": a.ID, "label": "无法解决", "note": "证书要你签"}})
	read("today", &today)
	if len(today.Asks) != 1 || today.Asks[0].Kind != "escalate" || today.Asks[0].Title != "证书要你签" || today.Asks[0].ID != task.ID ||
		today.Asks[0].Sub != "运行时负责人（"+a.ID+"） 上报：无法解决" {
		t.Errorf("上报应进等你：%+v", today.Asks)
	}
	// 页面上提到身份、机器都写名字：侧栏带着名字表，抽屉里等负责人时写负责人的名字。
	names, err := loadNav(ctx, db)
	if err != nil || names.Names["u1"] != "你" || names.Names[a.ID] != "运行时负责人" || names.Names["h1"] != "本机" {
		t.Errorf("名字表：%+v %v", names.Names, err)
	}
	running := ledger.Task{Status: ledger.Running}
	for h, want := range map[watch.Holder]string{
		{Kind: "leader", Who: a.ID, Text: "等负责人验收"}:             "运行时负责人（" + a.ID + "）：等负责人验收",
		{Kind: "secretary", Who: org.Secretary, Text: "待分派"}:    "秘书：待分派",
		{Kind: "worker", Who: "claude+opus", Text: "执行者在做（h1）"}: "执行者在做",
		{Kind: "user", Who: "u1", Text: "等你验收"}:                 "等你验收",
	} {
		if got := holderText(running, h, names.Names); got != want {
			t.Errorf("抽屉里的等待对象 %+v：%q", h, got)
		}
	}
	read("dept/"+sub.ID, &page)
	if page.Leader == nil || page.Leader.Name != "运行时负责人" || page.Leader.Inherited ||
		!reflect.DeepEqual(page.Leader.Depts, []Pair{{sub.ID, sub.Name}}) || page.Leader.Memo != "" || page.MemoMax != org.MaxMemo {
		t.Errorf("负责人（没写备忘时为空串，抽屉写用量/上限）：%+v memo_max=%d", page.Leader, page.MemoMax)
	}
	// 来源一行的记录人：负责人记的给名字和他的负责人抽屉地址（部门/身份），秘书记的只给名字，没来源的不给。
	for _, c := range []struct{ by, name, lead, src string }{{a.ID, "运行时负责人（" + a.ID + "）", sub.ID + "/" + a.ID, "org"}, {org.Secretary, "秘书", "", "org"}, {a.ID, "", "", ""}} {
		dr, err := ledger.Add(ctx, db, ledger.NewTask{Title: "发现", Org: sub.ID, Draft: true, Source: ledger.Source(c.src)}, c.by)
		if err != nil {
			t.Fatal(err)
		}
		if d, err := loadTask(ctx, db, dr.ID); err != nil || d.ByName != c.name || d.ByLead != c.lead {
			t.Errorf("%s 记的草稿：%q %q %v", c.by, d.ByName, d.ByLead, err)
		}
	}
	// 自己没有负责人：显示往上最近一级的，标成继承；抽屉里看到的负责部门与备忘和本人的一样。上面一路都没有就是空（你直接管）。
	leaf, _ := org.Add(ctx, db, org.NewDept{Name: "网页", Parent: sub.ID})
	other, _ := org.Add(ctx, db, org.NewDept{Name: "发版", Parent: root.ID})
	if _, err := org.Edit(ctx, db, other.ID, org.DeptPatch{Leader: &a.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := org.SetMemo(ctx, db, a.ID, "先修长时间没进展\n再做网页", a.ID); err != nil {
		t.Fatal(err)
	}
	read("dept/"+leaf.ID, &page)
	if page.Leader == nil || page.Leader.ID != a.ID || !page.Leader.Inherited || page.Leader.Memo != "先修长时间没进展\n再做网页" ||
		!reflect.DeepEqual(page.Leader.Depts, []Pair{{sub.ID, sub.Name}, {other.ID, "发版"}}) {
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
	if g := page.Tasks[0]; g.State != "run" || g.Who != "子任务 1/3 结束" {
		t.Errorf("目标自身待派、子任务在做，行首在做、行尾写子任务：%s %q", g.State, g.Who)
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
	if d.Parent != nil && (d.Parent.State != "run" || d.Parent.Who != "子任务 1/3 结束") {
		t.Errorf("抽屉里的上级同样按子任务在做：%+v", d.Parent)
	}
	if d, err = loadTask(ctx, db, goal.ID); err != nil || d.State != "run" || d.Holder != "子任务在做（1/3 结束）" {
		t.Errorf("目标的抽屉：%s %q %v", d.State, d.Holder, err)
	}
	d, err = loadTask(ctx, db, iface.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.Parent != nil || len(d.Kids) != 0 || len(d.Waits) != 0 || !reflect.DeepEqual(ids(d.Waiters), []string{b.ID}) {
		t.Errorf("接口的抽屉：%+v", d)
	}
}

// 定时任务：部门页只列本部门的并挂上一轮；今天页列 7 天内到点的、更远的只给条数；暂停沿树继承；分派任务失败标出来。
func TestSchedules(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	env := &app.Env{DB: db, Pause: &pause.Store{DB: db}, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	root, _ := org.Add(ctx, db, org.NewDept{Name: "组织"})
	sub, _ := org.Add(ctx, db, org.NewDept{Name: "运行时", Parent: root.ID})
	leaf, _ := org.Add(ctx, db, org.NewDept{Name: "网页", Parent: sub.ID})
	other, _ := org.Add(ctx, db, org.NewDept{Name: "文章", Parent: root.ID})
	now := store.Now()
	add := func(dept, every, at, kind string) agenda.Schedule {
		x, err := agenda.AddSchedule(ctx, db, agenda.NewSchedule{Org: dept, Title: "巡一遍", Kind: kind, Every: every, At: at}, "secretary", now, time.Local)
		if err != nil {
			t.Fatal(err)
		}
		return x
	}
	daily := add(leaf.ID, "1d", "09:00", "patrol")
	half := add(other.ID, "12h", "", "")
	add(other.ID, "30d", "", "research")
	// 上一轮分派任务失败、还没结束；上级部门暂停。
	agenda.Enqueue = func(context.Context, *app.Env, string, string) error { return errors.New("没有能接的执行者") }
	t.Cleanup(func() { agenda.Enqueue = nil })
	round, err := agenda.RunNow(ctx, env, daily.ID, time.Local)
	if err == nil || round.ID == "" {
		t.Fatalf("分派任务失败也该生成任务：%+v %v", round, err)
	}
	if err := env.Pause.Set(ctx, sub.ID, "u1"); err != nil {
		t.Fatal(err)
	}

	page, err := loadDept(ctx, db, t.TempDir(), leaf.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Schedules) != 1 || page.SchedMax != org.MaxSchedules {
		t.Fatalf("部门页只列本部门的：%+v", page.Schedules)
	}
	s := page.Schedules[0]
	if s.ID != daily.ID || !s.Paused || !s.Trouble || s.Kind != "体验巡检" || s.Cadence != "每天 09:00" ||
		s.Last == nil || s.Last.ID != round.ID || s.Last.Who != "没派" {
		t.Errorf("暂停中、上一轮分派任务失败没结束：%+v %+v", s, s.Last)
	}
	if page, _ = loadDept(ctx, db, t.TempDir(), sub.ID); len(page.Schedules) != 0 {
		t.Errorf("下属部门的定时任务不算在上级页：%+v", page.Schedules)
	}

	today, err := loadToday(ctx, db, time.UnixMilli(now))
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]Sched{}
	for i, r := range today.Soon.Rows {
		ids[r.ID] = r
		if i > 0 && r.NextAt < today.Soon.Rows[i-1].NextAt {
			t.Errorf("按下一轮先后排：%+v", today.Soon.Rows)
		}
	}
	if len(today.Soon.Rows) != 2 || today.Soon.Later != 1 || !ids[daily.ID].Paused {
		t.Fatalf("7 天内两条、更远一条：%+v", today.Soon)
	}
	if h := ids[half.ID]; h.Paused || h.Trouble || h.Last != nil || h.Kind != "" || h.Cadence != "每 12 小时" || h.DeptName != "文章" {
		t.Errorf("没暂停、没跑过的：%+v", h)
	}

	d, err := loadSchedule(ctx, db, daily.ID)
	if err != nil || len(d.Rounds) != 1 || d.Rounds[0].ID != round.ID || d.By != "secretary" || !strings.Contains(d.Note, agenda.DispatchFailed) {
		t.Fatalf("抽屉：%+v %v", d, err)
	}
	if _, err := loadSchedule(ctx, db, "s999"); err == nil {
		t.Error("没有的定时任务应报错")
	}
}

// 部门页头的验收人（沿用上级的写出处，缺省 auto 不给）与资料上限；任务抽屉来自哪条定时任务、牵着哪份选项单。
func TestDeptHeadAndTaskLinks(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	env := &app.Env{DB: db, Pause: &pause.Store{DB: db}, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	root, _ := org.Add(ctx, db, org.NewDept{Name: "组织"})
	sub, _ := org.Add(ctx, db, org.NewDept{Name: "运行时", Parent: root.ID})
	own, _ := org.Add(ctx, db, org.NewDept{Name: "网页", Parent: root.ID})
	free, _ := org.Add(ctx, db, org.NewDept{Name: "文章"})
	user, leader := org.AcceptUser, org.AcceptLeader
	org.Edit(ctx, db, root.ID, org.DeptPatch{Accept: &user})
	org.Edit(ctx, db, own.ID, org.DeptPatch{Accept: &leader})
	for _, c := range []struct {
		dept string
		want *Accept
	}{
		{sub.ID, &Accept{Who: user, From: root.ID, FromName: "组织"}},
		{own.ID, &Accept{Who: leader, From: own.ID, FromName: "网页"}},
		{free.ID, nil},
	} {
		page, err := loadDept(ctx, db, t.TempDir(), c.dept)
		if err != nil || !reflect.DeepEqual(page.Accept, c.want) || page.MatMax != org.MaxMaterial {
			t.Errorf("%s 验收人：%+v %v", c.dept, page.Accept, err)
		}
	}

	x, err := agenda.AddSchedule(ctx, db, agenda.NewSchedule{Org: sub.ID, Title: "调研", Kind: "research", Every: "7d"}, "secretary", store.Now(), time.Local)
	if err != nil {
		t.Fatal(err)
	}
	agenda.Enqueue = func(context.Context, *app.Env, string, string) error { return nil }
	t.Cleanup(func() { agenda.Enqueue = nil })
	round, err := agenda.RunNow(ctx, env, x.ID, time.Local)
	if err != nil {
		t.Fatal(err)
	}
	env.Paths.Data = t.TempDir()
	material, err := org.AddMaterial(ctx, db, env.Paths.Data, org.MaterialInput{Org: sub.ID, Note: "测试依据", Files: []org.MaterialFile{{Name: "27.svg", Content: []byte("<svg/>")}}}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	opt := agenda.OptionInput{Title: "A", Gain: "g", WhyNow: "w", Cost: "c", IfNot: "i", Evidence: material.ID + "/27.svg"}
	c, err := agenda.AddChoice(ctx, db, env.Paths.Data, agenda.ChoiceInput{Org: sub.ID, Title: "下一步", Options: []agenda.OptionInput{opt, opt, opt},
		Recommend: []int{1}, Reason: "r"}, round.ID, "secretary")
	if err != nil {
		t.Fatal(err)
	}
	if c, err = agenda.Decide(ctx, db, c.ID, []int{2}, "", "u1"); err != nil {
		t.Fatal(err)
	}
	plain, _ := ledger.Add(ctx, db, ledger.NewTask{Title: "秘书建的", Org: sub.ID}, "secretary")
	for _, w := range []struct{ id, schedule, choice string }{
		{round.ID, x.ID, c.ID},        // 定时任务生成的调研轮，交出了选项单
		{c.Options[1].Task, "", c.ID}, // 从选项单选出来的
		{plain.ID, "", ""},            // 建它的是 secretary，不当成定时任务
	} {
		d, err := loadTask(ctx, db, w.id)
		if err != nil || d.Schedule != w.schedule || d.Choice != w.choice {
			t.Errorf("%s 抽屉：来自 %q 选项单 %q %v", w.id, d.Schedule, d.Choice, err)
		}
	}
}

// 上线提示只看 shipped 上报，已确认仍算，普通上报与任务结束不算。
func TestNavShippedID(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	read := func(want int64) {
		t.Helper()
		nav, err := loadNav(ctx, db)
		if err != nil || nav.ShippedID != want {
			t.Fatalf("shipped_id=%d，want=%d，err=%v", nav.ShippedID, want, err)
		}
	}
	emit := func(kind string) {
		t.Helper()
		if err := events.Emit(ctx, db, events.Event{Kind: events.LeaderEscalate, Target: "a1", Body: map[string]any{"kind": kind}}); err != nil {
			t.Fatal(err)
		}
	}
	read(0)
	emit("stuck")
	read(0)
	emit("shipped")
	read(2)
	if _, err := db.ExecContext(ctx, `UPDATE events SET acked_at = 1 WHERE id = 2`); err != nil {
		t.Fatal(err)
	}
	read(2)
	emit("cross")
	read(2)
	emit("shipped")
	read(4)
}

// 今天完成超出列表上限时，没列出的件数单独给出，页面总数不被截在上限上。
func TestTodayShippedMore(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	root, _ := org.Add(ctx, db, org.NewDept{Name: "组织"})
	for i := 0; i < 102; i++ {
		x, err := ledger.Add(ctx, db, ledger.NewTask{Title: "做完的", Org: root.ID}, "u1")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ledger.Apply(ctx, db, x.ID, ledger.Event{Kind: ledger.Set, To: ledger.Done}, "u1", ""); err != nil {
			t.Fatal(err)
		}
	}
	today, err := loadToday(ctx, db, time.Now())
	if err != nil || len(today.Shipped) != 100 || today.ShippedMore != 2 {
		t.Fatalf("列出 %d 件、没列出 %d 件，want 100、2；err=%v", len(today.Shipped), today.ShippedMore, err)
	}
}
