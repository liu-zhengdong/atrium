package watch

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 隔离实例：真实 SQLite、账本、巡检与事件队列；时间与身份均为假数据。
func TestOverdueLifecycle(t *testing.T) {
	env, ctx := setup(t)
	task, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "提醒复现", Org: "o2", Owner: "a1"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	since := int64(100 * minute)
	if _, err = env.DB.Exec(`UPDATE tasks SET updated_at = ? WHERE id = ?`, since, task.ID); err != nil {
		t.Fatal(err)
	}
	task, err = ledger.Get(ctx, env.DB, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	tick := func(now int64) {
		t.Helper()
		if err := checkTask(ctx, env, nil, Hooks{}, task, now); err != nil {
			t.Fatal(err)
		}
	}
	count := func(want int) {
		t.Helper()
		var n int
		if err := env.DB.QueryRow(`SELECT count(*) FROM events WHERE kind = ? AND task = ?`, events.Overdue, task.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != want {
			t.Fatalf("overdue=%d，期望%d", n, want)
		}
	}
	tick(since + 31*minute)
	var id int64
	var target string
	if err := env.DB.QueryRow(`SELECT id,target FROM events WHERE kind = ? AND task = ?`, events.Overdue, task.ID).Scan(&id, &target); err != nil {
		t.Fatal(err)
	}
	t.Logf("首次提醒 target=%s", target)
	var raw string
	if err := env.DB.QueryRow(`SELECT body FROM events WHERE id = ?`, id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	row := events.Row{ID: id, Task: task.ID, Target: target, Kind: events.Overdue, Body: json.RawMessage(raw)}
	line := events.Line(row, map[string]string{"a1": "Atrium 负责人", "a2": "部门负责人"})
	if !strings.Contains(line, "收件人：Atrium 负责人（a1）") || !strings.Contains(line, "已 31 分钟") {
		t.Fatal(line)
	}
	var body map[string]any
	if err := json.Unmarshal(row.Body, &body); err != nil {
		t.Fatal(err)
	}
	if body["holder"] != "a1" || strings.Contains(raw, "Atrium 负责人") {
		t.Fatalf("提醒事实被改写：%s", raw)
	}
	t.Logf("watch overdue → Emit → Line: %s\n原始 body: %s", line, raw)

	if target != "a1" {
		t.Errorf("实际处理人a1，部门负责人a2；首次投给%s", target)
	}
	tick(since + 32*minute)
	count(1)
	if _, err := events.Take(ctx, env.DB, target, false); err != nil {
		t.Fatal(err)
	}
	tick(since + 33*minute)
	count(1)
	if _, err := events.Retarget(ctx, env.DB, []int64{id}, target, events.Secretary); err != nil {
		t.Fatal(err)
	}
	tick(since + 34*minute)
	count(1)
	if _, err := events.Ack(ctx, env.DB, []int64{id}, "", "u1"); err != nil {
		t.Fatal(err)
	}
	tick(since + 35*minute)
	count(1)
	// 清理已确认事件不能抹掉尚未结束等待的提醒凭据。
	if _, err := events.Prune(ctx, env.DB, store.Now()+events.Retention.Milliseconds()); err != nil {
		t.Fatal(err)
	}
	tick(since + 36*minute)
	count(1)
	// 重开同一隔离库，模拟服务重启，不借助内存去重。
	path := ""
	if err := env.DB.QueryRow(`SELECT file FROM pragma_database_list WHERE name = 'main'`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	if err := env.DB.Close(); err != nil {
		t.Fatal(err)
	}
	env.DB, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer env.DB.Close()
	tick(since + 37*minute)
	count(1)
	tick(since + 61*minute)
	count(2)
	if err := env.DB.QueryRow(`SELECT target FROM events WHERE kind = ? AND task = ? ORDER BY id DESC LIMIT 1`, events.Overdue, task.ID).Scan(&target); err != nil {
		t.Fatal(err)
	}
	if target != events.Secretary {
		t.Fatalf("a1上级应为secretary，得到%s", target)
	}
	tick(since + 62*minute)
	count(2)
	task.UpdatedAt = since + 70*minute
	tick(task.UpdatedAt + 31*minute)
	count(3)
	t.Log("巡检、租约、转交、确认、清理、重开库不重复；新级别、新等待各新增一次")
}

func TestOverdueRoleRoutes(t *testing.T) {
	for _, c := range []struct {
		name string
		h    Holder
		want string
	}{
		{"负责人到实际holder", Holder{Kind: "leader", Who: "a1", Role: RoleLeader}, "a1"},
		{"用户验收经秘书", Holder{Kind: "user", Who: "u1", Role: RoleAccept}, events.Secretary},
		{"负责人验收到验收人", Holder{Kind: "leader", Who: "a2", Role: RoleAccept}, "a2"},
		{"秘书等待", Holder{Kind: "secretary", Who: events.Secretary, Role: RoleLeader}, events.Secretary},
		{"执行者停滞交负责人", Holder{Kind: "worker", Who: "fake", Role: RoleWorker}, "a2"},
		{"启动停滞交负责人", Holder{Kind: "worker", Who: "fake", Role: RoleWorkerStart}, "a2"},
		{"检查交负责人", Holder{Kind: "check", Who: "运行时", Role: RoleCheck}, "a2"},
		{"发版交负责人", Holder{Kind: "release", Who: "运行时", Role: RoleRelease}, "a2"},
	} {
		t.Run(c.name, func(t *testing.T) {
			env, ctx := setup(t)
			task, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: c.name, Org: "o2"}, "u1")
			if err != nil {
				t.Fatal(err)
			}
			h := c.h
			h.Since = 100 * minute
			// 路由由 perform 所有；不拉起进程，动作本身的状态机另由既有测试覆盖。
			if err := perform(ctx, env, Hooks{}, task, Facts{Owner: "a2"}, h, Obs{}, Notify, h.Since+Limit(h.Role).Milliseconds()); err != nil {
				t.Fatal(err)
			}
			var target string
			if err := env.DB.QueryRow(`SELECT target FROM events WHERE kind = ? AND task = ?`, events.Overdue, task.ID).Scan(&target); err != nil {
				t.Fatal(err)
			}
			if target != c.want {
				t.Fatalf("target=%s，期望%s", target, c.want)
			}
		})
	}
}

func TestOverdueNewHolderAndFinishedRetention(t *testing.T) {
	env, ctx := setup(t)
	task, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "新holder", Org: "o2"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	h := Holder{Kind: "leader", Who: "a2", Role: RoleLeader, Since: 100 * minute}
	for _, who := range []string{"a2", "a1"} {
		h.Who = who
		if err := overdue(ctx, env.DB, who, task.ID, task.Org, h, 1, 131*minute, task.Title); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	if err := env.DB.QueryRow(`SELECT count(*) FROM events WHERE kind = ? AND task = ?`, events.Overdue, task.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("新holder应提醒，得到%d", n)
	}
	if _, err := env.DB.Exec(`UPDATE events SET acked_at = 1 WHERE task = ?`, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.Apply(ctx, env.DB, task.ID, ledger.Event{Kind: ledger.Cancel}, "u1", ""); err != nil {
		t.Fatal(err)
	}
	nDeleted, err := events.Prune(ctx, env.DB, store.Now()+events.Retention.Milliseconds())
	if err != nil {
		t.Fatal(err)
	}
	if nDeleted < 2 {
		t.Fatalf("结束后应清理提醒，删除%d", nDeleted)
	}
}

func TestOverdueConcurrent(t *testing.T) {
	env, ctx := setup(t)
	task, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "并发巡检", Org: "o2"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	h := Holder{Kind: "leader", Who: "a2", Role: RoleLeader, Since: 100 * minute}
	results := make(chan error, 8)
	for i := 0; i < 8; i++ {
		go func() { results <- overdue(ctx, env.DB, "a2", task.ID, task.Org, h, 1, 131*minute, task.Title) }()
	}
	for i := 0; i < 8; i++ {
		select {
		case err := <-results:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("并发巡检超时")
		}
	}
	var n int
	if err := env.DB.QueryRow(`SELECT count(*) FROM events WHERE kind = ? AND task = ?`, events.Overdue, task.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("并发应仅一条，得到%d", n)
	}
}
