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
		{"等依赖不算期限", Facts{Task: task(ledger.Todo, ""), Owner: "a1", WaitingOn: []string{"t2"}}, "deps", "", "", 0},
		{"没负责人归秘书", Facts{Task: task(ledger.Blocked, ""), Owner: "secretary"}, "secretary", "secretary", RoleLeader, 500},
		{"排队", Facts{Task: task(ledger.Queued, "")}, "runtime", "运行时", "", 0},
		{"执行者刚起", Facts{Task: task(ledger.Running, ""), Proc: proc}, "worker", "codex", RoleWorkerStart, 1000},
		{"执行者有进展", Facts{Task: task(ledger.Running, ""), Proc: proc, ProgressAt: 2000}, "worker", "codex", RoleWorker, 2000},
		{"执行者没登记进程", Facts{Task: task(ledger.Running, "")}, "worker", "codex", "", 0},
		{"关卡", Facts{Task: task(ledger.Running, ledger.StageGate)}, "runtime", "运行时", "", 0},
		{"检查在跑", Facts{Task: task(ledger.Running, ledger.StageMerge), Proc: &Proc{Role: "check", At: 700}}, "check", "运行时", RoleCheck, 700},
		{"排队合入", Facts{Task: task(ledger.Running, ledger.StageMerge)}, "runtime", "运行时", "", 0},
		{"等发版", Facts{Task: task(ledger.Running, ledger.StageMerged)}, "release", "运行时", RoleRelease, 500},
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
