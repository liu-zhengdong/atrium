package watch

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 测试二进制兼当假执行者：WATCH_HELPER=sleep 时睡 30 秒。
func TestMain(m *testing.M) {
	if os.Getenv("WATCH_HELPER") == "sleep" {
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

const minute = int64(60000)

func TestLevel(t *testing.T) {
	now := int64(100 * minute)
	cases := []struct {
		role  Role
		since int64
		want  int
	}{
		{RoleWorkerStart, now - 2*minute, 0},
		{RoleWorkerStart, now - 3*minute, 1},
		{RoleWorker, now - 19*minute, 0},
		{RoleWorker, now - 20*minute, 1},
		{RoleLeader, now - 30*minute, 1},
		{RoleLeader, now - 60*minute, 2},
		{RoleSecretary, now - 3*minute, 1},
		{"", now - 90*minute, 0},
		{RoleLeader, 0, 0},
	}
	for _, c := range cases {
		if got := Level(Holder{Role: c.role, Since: c.since}, now); got != c.want {
			t.Errorf("Level(%s, 持球 %d 分) = %d，应为 %d", c.role, (now-c.since)/minute, got, c.want)
		}
	}
}

func TestHolderOf(t *testing.T) {
	proc := &Proc{Role: "worker", PID: 1, At: 1000}
	task := func(s ledger.Status, st ledger.Stage) ledger.Task {
		return ledger.Task{ID: "t1", Status: s, Stage: st, Worker: "codex", UpdatedAt: 500}
	}
	cases := []struct {
		name  string
		f     Facts
		kind  string
		who   string
		role  Role
		since int64
	}{
		{"待派活归负责人", Facts{Task: task(ledger.Todo, ""), Owner: "a1"}, "leader", "a1", RoleLeader, 500},
		{"等依赖不算期限", Facts{Task: task(ledger.Todo, ""), Owner: "a1", Deps: []ledger.DepState{{ID: "t2", Status: ledger.Running}, {ID: "t3", Status: ledger.Done}}}, "deps", "", "", 0},
		{"依赖取消了归负责人", Facts{Task: task(ledger.Todo, ""), Owner: "a1", Deps: []ledger.DepState{{ID: "t2", Status: ledger.Cancelled}, {ID: "t3", Status: ledger.Done}}}, "leader", "a1", RoleLeader, 500},
		{"依赖失败了归负责人，在等的也不算", Facts{Task: task(ledger.Todo, ""), Owner: "a1", Deps: []ledger.DepState{{ID: "t2", Status: ledger.Failed}, {ID: "t3", Status: ledger.Running}}}, "leader", "a1", RoleLeader, 500},
		{"子任务在做不算期限", Facts{Task: task(ledger.Todo, ""), Owner: "a1", OpenChildren: 2, Children: 3}, "children", "", "", 0},
		{"子任务都结束了等负责人收尾", Facts{Task: task(ledger.Todo, ""), Owner: "a1", Children: 3}, "leader", "a1", RoleLeader, 500},
		{"排队等依赖不算期限", Facts{Task: task(ledger.Queued, ""), Deps: []ledger.DepState{{ID: "t2", Status: ledger.Todo}}}, "deps", "", "", 0},
		{"没负责人归秘书", Facts{Task: task(ledger.Blocked, ""), Owner: "secretary"}, "secretary", "secretary", RoleLeader, 500},
		{"排队", Facts{Task: task(ledger.Queued, "")}, "runtime", "运行时", "", 0},
		{"执行者刚起", Facts{Task: task(ledger.Running, ""), Proc: proc}, "worker", "codex", RoleWorkerStart, 1000},
		{"执行者有进展", Facts{Task: task(ledger.Running, ""), Proc: proc, ProgressAt: 2000}, "worker", "codex", RoleWorker, 2000},
		{"执行者没登记进程", Facts{Task: task(ledger.Running, "")}, "worker", "codex", "", 0},
		{"关卡", Facts{Task: task(ledger.Running, ledger.StageGate)}, "runtime", "运行时", "", 0},
		{"检查在跑", Facts{Task: task(ledger.Running, ledger.StageMerge), Proc: &Proc{Role: "check", At: 700}}, "check", "运行时", RoleCheck, 700},
		{"排队合入", Facts{Task: task(ledger.Running, ledger.StageMerge)}, "runtime", "运行时", "", 0},
		{"等发版", Facts{Task: task(ledger.Running, ledger.StageMerged)}, "release", "运行时", RoleRelease, 500},
		{"等你验收", Facts{Task: task(ledger.Running, ledger.StageAccept), Owner: "a1", Acceptor: org.AcceptUser}, "user", "u1", RoleAccept, 500},
		{"等负责人验收", Facts{Task: task(ledger.Running, ledger.StageAccept), Owner: "a1", Acceptor: org.AcceptLeader}, "leader", "a1", RoleAccept, 500},
		{"失败归负责人", Facts{Task: task(ledger.Failed, ""), Owner: "a2"}, "leader", "a2", RoleLeader, 500},
		{"已完成", Facts{Task: task(ledger.Done, "")}, "", "", "", 0},
	}
	for _, c := range cases {
		h := HolderOf(c.f)
		if h.Kind != c.kind || h.Who != c.who || h.Role != c.role || h.Since != c.since {
			t.Errorf("%s：%+v", c.name, h)
		}
	}
}

// t455：依赖 t449 取消、t456 完成后不能再显示「等 t449 完成」，要归负责人计时，下一步改依赖（留下没断的）。
func TestHolderBrokenDeps(t *testing.T) {
	dep := func(id string, s ledger.Status) ledger.DepState { return ledger.DepState{ID: id, Status: s} }
	for name, c := range map[string]struct {
		deps       []ledger.DepState
		text, next string
	}{
		"取消一件": {[]ledger.DepState{dep("t449", ledger.Cancelled), dep("t456", ledger.Done)},
			"依赖的 t449 已取消，改依赖或取消", "atrium task set t455 --after t456"},
		"全断了": {[]ledger.DepState{dep("t449", ledger.Cancelled), dep("t450", ledger.Failed)},
			"依赖的 t449 已取消、t450 失败了，改依赖或取消", `atrium task set t455 --after ""`},
		"留下在等的": {[]ledger.DepState{dep("t449", ledger.Failed), dep("t456", ledger.Running), dep("t457", ledger.Done)},
			"依赖的 t449 失败了，改依赖或取消", "atrium task set t455 --after t456,t457"},
	} {
		h := HolderOf(Facts{Task: ledger.Task{ID: "t455", Status: ledger.Todo, UpdatedAt: 500}, Owner: "a3", Deps: c.deps})
		if h.Text != c.text || h.Next != c.next || h.Who != "a3" || h.Role != RoleLeader {
			t.Errorf("%s：%+v", name, h)
		}
		// 负责人一行计时：到期叫醒，再到期上交。
		if Decide(h, Obs{}, 500+int64(31*minute)) != Notify || Decide(h, Obs{}, 500+int64(61*minute)) != Escalate {
			t.Errorf("%s：到期应叫醒负责人", name)
		}
	}
}

func TestDecide(t *testing.T) {
	now := int64(100 * minute)
	worker := func(role Role, since int64) Holder { return Holder{Kind: "worker", Role: role, Since: since} }
	cases := []struct {
		name string
		h    Holder
		o    Obs
		want Action
	}{
		{"在跑没到期", worker(RoleWorker, now-minute), Obs{Alive: true}, Keep},
		{"启动卡住第一次重试", worker(RoleWorkerStart, now-4*minute), Obs{Alive: true}, Retry},
		{"启动再卡转失败", worker(RoleWorkerStart, now-4*minute), Obs{Alive: true, StartStucks: 1}, Fail},
		{"运行卡住转受阻", worker(RoleWorker, now-21*minute), Obs{Alive: true}, BlockIt},
		{"临时错误重试", worker(RoleWorker, now-minute), Obs{Alive: true, Signal: SigTransient}, Retry},
		{"额度用尽重试", worker(RoleWorker, now-minute), Obs{Alive: true, Signal: SigQuota}, Retry},
		{"刚退出先等拉起者收尾", worker(RoleWorker, now-minute), Obs{DeadTicks: 1}, Keep},
		{"没人收尾且没报错进关卡", worker(RoleWorker, now-minute), Obs{DeadTicks: 2}, ExitOK},
		{"没人收尾且报错", worker(RoleWorker, now-minute), Obs{DeadTicks: 2, Signal: SigError}, ExitFail},
		{"没人收尾且思考耗尽", worker(RoleWorker, now-minute), Obs{DeadTicks: 3, Signal: SigThinking}, Retry},
		{"检查没输出", Holder{Kind: "check", Role: RoleCheck, Since: now - 11*minute}, Obs{Alive: true}, KillIt},
		{"检查已退出不管", Holder{Kind: "check", Role: RoleCheck, Since: now - 11*minute}, Obs{}, Keep},
		{"等发版到期", Holder{Kind: "release", Role: RoleRelease, Since: now - 31*minute}, Obs{}, Notify},
		{"负责人到期", Holder{Kind: "leader", Role: RoleLeader, Since: now - 31*minute}, Obs{}, Notify},
		{"负责人再到期上交", Holder{Kind: "leader", Role: RoleLeader, Since: now - 61*minute}, Obs{}, Escalate},
		{"验收人没到期", Holder{Kind: "user", Role: RoleAccept, Since: now - 60*minute}, Obs{}, Keep},
		{"验收人到期提醒", Holder{Kind: "user", Role: RoleAccept, Since: now - 25*60*minute}, Obs{}, Notify},
		{"验收人只提醒一次不上交", Holder{Kind: "user", Role: RoleAccept, Since: now - 49*60*minute}, Obs{}, Keep},
		{"不算期限", Holder{Kind: "runtime"}, Obs{}, Keep},
	}
	for _, c := range cases {
		if got := Decide(c.h, c.o, now); got != c.want {
			t.Errorf("%s：Decide = %q，应为 %q", c.name, got, c.want)
		}
	}
}

func setup(t *testing.T) (*app.Env, context.Context) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	for _, q := range []string{
		`INSERT INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0), ('a2', 'leader', '乙', 0)`,
		`INSERT INTO departments (id, parent, name, leader, created_at, updated_at) VALUES ('o1', NULL, '公司', 'a1', 0, 0)`,
		`INSERT INTO departments (id, parent, name, leader, created_at, updated_at) VALUES ('o2', 'o1', '运行时', 'a2', 0, 0)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	mem.m = map[string]*progress{}
	return &app.Env{DB: db, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Pause: &pause.Store{DB: db}}, context.Background()
}

// running 建一件在跑的任务并登记进程。
func running(t *testing.T, env *app.Env, ctx context.Context, p Proc) ledger.Task {
	t.Helper()
	task, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "活", Org: "o2"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []ledger.EventKind{ledger.Enqueue, ledger.Start} {
		if _, err := ledger.Apply(ctx, env.DB, task.ID, ledger.Event{Kind: k}, "runtime", ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := Track(ctx, env.DB, task.ID, p); err != nil {
		t.Fatal(err)
	}
	return task
}

func sleeper(t *testing.T) int {
	t.Helper()
	env := platform.EnvMap(os.Environ())
	env["WATCH_HELPER"] = "sleep"
	cmd, err := platform.Start(platform.Spec{Path: os.Args[0], Args: []string{"-test.run=^$"}, Env: env, Detached: true})
	if err != nil {
		t.Fatal(err)
	}
	go cmd.Wait()
	t.Cleanup(func() { platform.KillTree(cmd.Process.Pid) })
	return cmd.Process.Pid
}

func status(t *testing.T, env *app.Env, id string) ledger.Task {
	t.Helper()
	task, err := ledger.Get(context.Background(), env.DB, id)
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func TestTickTakesOverExitedWorker(t *testing.T) {
	env, ctx := setup(t)
	task := running(t, env, ctx, Proc{Role: "worker", PID: 999999, Log: filepath.Join(t.TempDir(), "log")})
	Tick(ctx, env)
	if s := status(t, env, task.ID); s.Stage != "" {
		t.Fatalf("第一轮应等拉起者收尾：%+v", s)
	}
	if err := Tick(ctx, env); err != nil {
		t.Fatal(err)
	}
	if s := status(t, env, task.ID); s.Status != ledger.Running || s.Stage != ledger.StageGate {
		t.Fatalf("连续两轮不在应进关卡：%+v", s)
	}
}

func TestTickStartStuckRetriesThenBlocks(t *testing.T) {
	env, ctx := setup(t)
	var requeued []Why
	Use(Hooks{Requeue: func(ctx context.Context, task string, why Why) error {
		requeued = append(requeued, why)
		return nil
	}})
	t.Cleanup(func() { hooks.h = Hooks{} })
	pid := sleeper(t)
	task := running(t, env, ctx, Proc{Role: "worker", PID: pid, Log: filepath.Join(t.TempDir(), "log"), At: store.Now() - 4*minute})
	if err := Tick(ctx, env); err != nil {
		t.Fatal(err)
	}
	if s := status(t, env, task.ID); s.Status != ledger.Failed {
		t.Fatalf("启动卡住应转失败并重新入队：%+v", s)
	}
	if len(requeued) != 1 {
		t.Fatalf("应调一次 Requeue：%+v", requeued)
	}
	deadline := time.Now().Add(5 * time.Second)
	for platform.Alive(pid) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if platform.Alive(pid) {
		t.Fatal("进程树没被结束")
	}
	rows, err := events.Pending(ctx, env.DB, "a2", false, 10)
	if err != nil {
		t.Fatal(err)
	}
	var overdue int
	for _, r := range rows {
		if r.Kind == events.Overdue {
			overdue++
		}
	}
	if overdue != 1 {
		t.Fatalf("应发一条 overdue 给 a2：%+v", rows)
	}

	// 有过进展后 20 分钟没动：转受阻。
	pid2 := sleeper(t)
	task2 := running(t, env, ctx, Proc{Role: "worker", PID: pid2, Log: filepath.Join(t.TempDir(), "log2")})
	mem.m[task2.ID] = &progress{pid: pid2, at: store.Now() - 21*minute}
	if err := Tick(ctx, env); err != nil {
		t.Fatal(err)
	}
	if s := status(t, env, task2.ID); s.Status != ledger.Blocked {
		t.Fatalf("运行卡住应转受阻：%+v", s)
	}
}

func TestTickPausedAndEscalates(t *testing.T) {
	env, ctx := setup(t)
	task, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "卡", Org: "o2"}, "u1")
	ledger.Apply(ctx, env.DB, task.ID, ledger.Event{Kind: ledger.Block}, "u1", "")
	env.DB.Exec(`UPDATE tasks SET updated_at = ? WHERE id = ?`, store.Now()-61*minute, task.ID)

	env.Pause.Set(ctx, pause.All, "u1")
	if err := Tick(ctx, env); err != nil {
		t.Fatal(err)
	}
	if rows, _ := events.Pending(ctx, env.DB, "a1", false, 10); len(rows) != 0 {
		t.Fatalf("全局暂停时不该发：%+v", rows)
	}
	env.Pause.Clear(ctx, pause.All)
	env.Pause.Set(ctx, "o1", "u1")
	Tick(ctx, env)
	if rows, _ := events.Pending(ctx, env.DB, "a1", false, 10); len(rows) != 0 {
		t.Fatalf("上级部门暂停时不该发：%+v", rows)
	}
	env.Pause.Clear(ctx, "o1")
	for i := 0; i < 2; i++ { // 第二轮不重发
		if err := Tick(ctx, env); err != nil {
			t.Fatal(err)
		}
	}
	rows, _ := events.Pending(ctx, env.DB, "a1", false, 10)
	if len(rows) != 1 || rows[0].Kind != events.Overdue || rows[0].Task != task.ID {
		t.Fatalf("受阻 60 分钟应上交 a1（o2 的上一层）一次：%+v", rows)
	}
	events.Ack(ctx, env.DB, []int64{rows[0].ID}, "", "u1")
	Tick(ctx, env)
	if rows, _ := events.Pending(ctx, env.DB, "a1", false, 10); len(rows) != 0 {
		t.Fatalf("确认后同一次到期不该再发：%+v", rows)
	}
}

// 等你验收超过一天：经秘书提醒一次，不投负责人、不往上交。
func TestTickRemindsUserToAccept(t *testing.T) {
	env, ctx := setup(t)
	env.DB.Exec(`INSERT INTO acceptors (department, who) VALUES ('o1', 'user')`)
	task, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "等验收", Org: "o2"}, "u1")
	for _, ev := range []ledger.Event{{Kind: ledger.Enqueue}, {Kind: ledger.Start}, {Kind: ledger.ExitOK}, {Kind: ledger.GatePass, AcceptBy: org.AcceptUser}} {
		if _, err := ledger.Apply(ctx, env.DB, task.ID, ev, "runtime", ""); err != nil {
			t.Fatal(err)
		}
	}
	env.DB.Exec(`UPDATE events SET acked_at = 1`) // 转入等验收时投的事件先确认掉，只看提醒
	env.DB.Exec(`UPDATE tasks SET updated_at = ? WHERE id = ?`, store.Now()-25*60*minute, task.ID)
	for i := 0; i < 2; i++ {
		if err := Tick(ctx, env); err != nil {
			t.Fatal(err)
		}
	}
	rows, _ := events.Pending(ctx, env.DB, "secretary", false, 10)
	if len(rows) != 1 || rows[0].Kind != events.Overdue || rows[0].Task != task.ID {
		t.Fatalf("应经秘书提醒一次：%+v", rows)
	}
	for _, who := range []string{"a1", "a2"} {
		if rows, _ := events.Pending(ctx, env.DB, who, false, 10); len(rows) != 0 {
			t.Fatalf("不该投负责人 %s：%+v", who, rows)
		}
	}
	env.DB.Exec(`UPDATE tasks SET updated_at = ? WHERE id = ?`, store.Now()-49*60*minute, task.ID)
	Tick(ctx, env)
	if rows, _ := events.Pending(ctx, env.DB, "secretary", false, 10); len(rows) != 1 {
		t.Fatalf("两天也只提醒过一次：%+v", rows)
	}
}
