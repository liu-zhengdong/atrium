package events

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func openDB(t *testing.T) *store.DB {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func exec(t *testing.T, db *store.DB, q string, args ...any) {
	t.Helper()
	if _, err := db.Exec(q, args...); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

func emit(t *testing.T, db *store.DB, e Event) {
	t.Helper()
	if err := db.Tx(context.Background(), func(tx *sql.Tx) error { return Emit(context.Background(), tx, e) }); err != nil {
		t.Fatal(err)
	}
}

func TestLevelAndKey(t *testing.T) {
	cases := []struct {
		name string
		kind string
		body any
		want string
	}{
		// 任务状态：失败、受阻、等验收、非用户本人做的完成要处理（用户本人标失败、受阻也要处理：那是要秘书接手的事）。
		{"失败", TaskStatus, map[string]any{"to": "failed", "by": "dispatch"}, Act},
		{"用户标失败", TaskStatus, map[string]any{"to": "failed", "by": "u1"}, Act},
		{"受阻", TaskStatus, map[string]any{"to": "blocked", "by": "watch"}, Act},
		{"用户标受阻", TaskStatus, map[string]any{"to": "blocked", "by": "u1"}, Act},
		{"等用户验收", TaskStatus, map[string]any{"to": "running", "stage": "accept", "accept_by": "user", "by": "gates"}, Act},
		{"用户放进应用·等负责人验收", TaskStatus, map[string]any{"to": "running", "stage": "accept", "accept_by": "leader", "by": "u1"}, Act},
		{"交付检查通过后直接完成", TaskStatus, map[string]any{"to": "done", "stage": "gate", "event": "gate_pass", "by": "gates"}, Act},
		{"已上线", TaskStatus, map[string]any{"to": "done", "stage": "released", "event": "land", "by": "release"}, Act},
		{"负责人验收通过", TaskStatus, map[string]any{"to": "done", "stage": "accept", "event": "accept", "by": "a1"}, Act},
		// 用户本人做的完成只知会：task set --status done、task accept。
		{"用户标完成", TaskStatus, map[string]any{"to": "done", "event": "set", "by": "u1"}, Info},
		{"用户验收通过", TaskStatus, map[string]any{"to": "done", "stage": "accept", "event": "accept", "by": "u1"}, Info},
		// 应用的中间步骤与过程只知会。
		{"已合入等发版", TaskStatus, map[string]any{"to": "running", "stage": "merged", "event": "land", "by": "merge"}, Info},
		{"拉起", TaskStatus, map[string]any{"to": "running", "by": "dispatch"}, Info},
		{"用户取消", TaskStatus, map[string]any{"to": "cancelled", "by": "u1"}, Info},
		{"无正文", TaskStatus, nil, Info},
		// 非任务事件：上线失败、到期、上限、上报
		{"自升级上线失败", OnlineFailed, nil, Act},
		{"等待到期", Overdue, nil, Act},
		{"上限满了", LimitFull, map[string]any{"key": "points"}, Act},
		{"负责人上报·卡住", LeaderEscalate, map[string]any{"kind": "stuck"}, Act},
		{"负责人上报·跨部门（级别由 leaders 按任务另定）", LeaderEscalate, map[string]any{"kind": "cross"}, Act},
		{"负责人上报·越权", LeaderEscalate, map[string]any{"kind": "beyond"}, Act},
		{"交给负责人去拆", TaskAssigned, map[string]any{"title": "任务"}, Act},
		{"未知种类", "other", map[string]any{"to": "failed"}, Info},
	}
	for _, c := range cases {
		if got := LevelOf(c.kind, c.body); got != c.want {
			t.Errorf("%s：LevelOf(%s, %v) = %s，应为 %s", c.name, c.kind, c.body, got, c.want)
		}
	}
	if k := KeyOf(Event{Kind: TaskStatus, Task: "t3"}); k != "task:t3" {
		t.Errorf("KeyOf = %q", k)
	}
	if k := KeyOf(Event{Kind: TaskAssigned, Task: "t3"}); k != "assigned:t3" {
		t.Errorf("交给负责人去拆与之后的补充说明合并，得到 %q", k)
	}
	if k := KeyOf(Event{Kind: Overdue, Task: "t3"}); k != "" {
		t.Errorf("overdue 缺省不合并，得到 %q", k)
	}
	if k := KeyOf(Event{Kind: LimitFull, Dept: "o2", Body: map[string]any{"key": "points"}}); k != "limit:o2:points" {
		t.Errorf("LimitFull KeyOf = %q", k)
	}
}

func TestRoute(t *testing.T) {
	st := func(to, stage string) map[string]any { return map[string]any{"to": to, "stage": stage} }
	none := Delivery{}
	cases := []struct {
		name, owner, leader string
		body                map[string]any
		want                Delivery // 零值表示不投
		by                  string
	}{
		// 处理人没有亲自操作的结果，沿原路由投递。
		{"用户处理·合入完成·有负责人", "u1", "a1", st("done", "merged"), Delivery{"a1", Act}, ""},
		{"用户处理·合入完成·无负责人", "u1", "", st("done", "merged"), Delivery{Secretary, Act}, ""},
		{"秘书处理·上线·有负责人", Secretary, "a1", st("done", "released"), Delivery{"a1", Act}, ""},
		{"秘书处理·已合入等发版只知会", Secretary, "a1", map[string]any{"to": "running", "stage": "merged", "event": "land"}, Delivery{"a1", Info}, ""},
		{"秘书处理·已合入等发版·无负责人", Secretary, "", map[string]any{"to": "running", "stage": "merged", "event": "land"}, Delivery{Secretary, Info}, ""},
		{"用户处理·用户验收通过只知会", "u1", "a1", map[string]any{"to": "done", "stage": "accept", "event": "accept", "by": "u1"}, Delivery{"a1", Info}, ""},
		{"用户处理·用户标受阻照旧要处理", "u1", "", map[string]any{"to": "blocked", "by": "u1"}, Delivery{Secretary, Act}, ""},
		{"秘书处理·失败·无负责人", Secretary, "", st("failed", ""), Delivery{Secretary, Act}, ""},
		{"负责人处理·受阻·本部门", "a1", "a1", st("blocked", "merge_queue"), Delivery{"a1", Act}, ""},
		{"负责人处理·完成·下属部门只投处理人", "a1", "a3", st("done", "gate"), Delivery{"a1", Act}, ""},
		{"负责人处理·已合入·下属部门只知会处理人", "a1", "a3", map[string]any{"to": "running", "stage": "merged", "event": "land"}, Delivery{"a1", Info}, ""},
		{"负责人处理·失败·无负责人", "a2", "", st("failed", ""), Delivery{"a2", Act}, ""},
		// 负责人亲自收尾，结果回到任务分派人；同一人派给自己或没有任务分派人则不投。
		{"负责人自己完成·秘书分派任务", "a1", "a1", map[string]any{"to": "done", "by": "a1"}, Delivery{Secretary, Act}, Secretary},
		{"负责人自己完成·用户分派任务", "a1", "a1", map[string]any{"to": "done", "by": "a1"}, Delivery{Secretary, Act}, "u1"},
		{"负责人自己完成·另一负责人分派任务", "a1", "a1", map[string]any{"to": "done", "by": "a1"}, Delivery{"a2", Act}, "a2"},
		{"负责人自己失败·秘书分派任务", "a1", "a1", map[string]any{"to": "failed", "by": "a1"}, Delivery{Secretary, Act}, Secretary},
		{"负责人自己受阻·另一负责人分派任务", "a1", "a1", map[string]any{"to": "blocked", "by": "a1"}, Delivery{"a2", Act}, "a2"},
		{"负责人自己完成·自己分派任务", "a1", "a1", map[string]any{"to": "done", "by": "a1"}, none, "a1"},
		{"负责人自己完成·没有任务分派人", "a1", "a1", map[string]any{"to": "done", "by": "a1"}, none, ""},
		{"执行者完成·仍投处理人", "a1", "a1", map[string]any{"to": "done", "by": "worker"}, Delivery{"a1", Act}, Secretary},
		{"运行时完成·仍投处理人", "a1", "a1", map[string]any{"to": "done", "by": "merge"}, Delivery{"a1", Act}, Secretary},
		// 等验收：投验收人，要处理。
		{"等用户验收·有负责人", "a1", "a1", map[string]any{"to": "running", "stage": "accept", "accept_by": "user", "by": "a1"}, Delivery{Secretary, Act}, "u1"},
		{"等负责人验收", "u1", "a1", map[string]any{"to": "running", "stage": "accept", "accept_by": "leader"}, Delivery{"a1", Act}, ""},
		{"等负责人验收·没有负责人投秘书", "u1", "", map[string]any{"to": "running", "stage": "accept", "accept_by": "leader"}, Delivery{Secretary, Act}, ""},
		// 运行时建的：按部门找负责人，成功只知会，失败、受阻要处理。
		{"运行时·完成·有负责人", "gates", "a1", st("done", "review"), Delivery{"a1", Info}, ""},
		{"运行时·受阻·有负责人", "gates", "a1", st("blocked", "gate"), Delivery{"a1", Act}, ""},
		{"运行时·失败·无负责人", "", "", st("failed", ""), Delivery{Secretary, Act}, ""},
		// 过程：没有要动手的事，谁都不投。
		{"用户处理·入队·有负责人", "u1", "a1", st("queued", ""), none, ""},
		{"用户处理·拉起·无负责人", "u1", "", st("running", ""), none, ""},
		{"秘书处理·交回一次", Secretary, "a1", st("queued", ""), none, ""},
		{"负责人处理·取消·本部门", "a1", "a1", st("cancelled", ""), none, ""},
		{"运行时·入队·无负责人", "gates", "", st("queued", ""), none, ""},
	}
	for _, c := range cases {
		got, ok := Route(c.owner, c.by, c.leader, TaskStatus, c.body)
		if ok != (c.want != none) || got != c.want {
			t.Errorf("%s：Route = %v %v，应为 %v", c.name, got, ok, c.want)
		}
	}
}

func TestEmitTask(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	exec(t, db, `INSERT INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0)`)
	exec(t, db, `INSERT INTO departments (id, parent, name, leader, created_at, updated_at) VALUES ('o1', NULL, '公司', 'a1', 0, 0)`)
	exec(t, db, `INSERT INTO tasks (id, department, title, status, created_at, updated_at) VALUES ('t1', 'o1', 'x', 'running', 0, 0)`)
	emitTask := func(owner, assigner, to, by string) {
		t.Helper()
		err := db.Tx(ctx, func(tx *sql.Tx) error {
			return EmitTask(ctx, tx, owner, assigner, Event{Kind: TaskStatus, Task: "t1", Dept: "o1", Body: map[string]any{"to": to, "by": by}, By: by})
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	// 用户派的活在有负责人的部门：过程不投，结果只投负责人，秘书不收。
	emitTask("u1", "u1", "queued", "u1")
	emitTask("u1", "u1", "running", "dispatch")
	emitTask("u1", "u1", "done", "merge")
	sec, _ := Pending(ctx, db, Secretary, true, 10)
	lead, _ := Pending(ctx, db, "a1", true, 10)
	if len(sec) != 0 {
		t.Fatalf("秘书不该收到：%+v", sec)
	}
	if len(lead) != 1 || lead[0].Level != Act || lead[0].Count != 1 || !strings.Contains(string(lead[0].Body), "done") {
		t.Fatalf("负责人应只收一条要处理的结果：%+v", lead)
	}
	Ack(ctx, db, []int64{lead[0].ID}, "", "u1")

	// 用户本人做的完成照样投负责人，只知会。
	emitTask("u1", "u1", "done", "u1")
	lead, _ = Pending(ctx, db, "a1", true, 10)
	if len(lead) != 1 || lead[0].Level != Info {
		t.Fatalf("用户本人做的完成，负责人应只收知会：%+v", lead)
	}
	Ack(ctx, db, []int64{lead[0].ID}, "", "u1")

	// 一次操作引出的事件不发给做这次操作的身份本人：负责人自己停下的不收，别人让它的活失败的照收。
	emitTask("a1", "a1", "blocked", "a1")
	if n, _ := Pending(ctx, db, "a1", true, 10); len(n) != 0 {
		t.Fatalf("负责人自己停下的不该收到：%+v", n)
	}
	emitTask("a2", "a2", "failed", "a1")
	if n, _ := Pending(ctx, db, "a2", true, 10); len(n) != 1 || n[0].Level != Act {
		t.Fatalf("处理人 a2 应收到要处理的失败：%+v", n)
	}
	if n, _ := Pending(ctx, db, Secretary, true, 10); len(n) != 0 {
		t.Fatalf("秘书不该收到：%+v", n)
	}
	// 负责人自己完成秘书派的活，事件落库给秘书，但完成回执对秘书只知会。
	emitTask("a1", Secretary, "done", "a1")
	if n, _ := Pending(ctx, db, Secretary, true, 10); len(n) != 1 || n[0].Level != Info {
		t.Fatalf("秘书应收到知会级的完成回执：%+v", n)
	}
}

func TestSecretaryAct(t *testing.T) {
	esc := func(kind string) map[string]any { return map[string]any{"kind": kind} }
	cases := []struct {
		name string
		kind string
		body any
		want bool
	}{
		{"问用户", LeaderEscalate, esc("ask"), true},
		{"知会用户", LeaderEscalate, esc("notify"), true},
		{"卡住", LeaderEscalate, esc("stuck"), true},
		{"越权", LeaderEscalate, esc("beyond"), true},
		{"跨部门协作", LeaderEscalate, esc("cross"), false},
		{"旧的里程碑上报", LeaderEscalate, esc("shipped"), false},
		{"选项单", ChoiceOpen, nil, true},
		{"等用户验收", TaskStatus, map[string]any{"to": "running", "accept_by": "user"}, true},
		{"任务失败", TaskStatus, map[string]any{"to": "failed"}, true},
		{"任务受阻", TaskStatus, map[string]any{"to": "blocked"}, true},
		{"完成回执", TaskStatus, map[string]any{"to": "done", "by": "a1"}, false},
		{"已上线回执", TaskStatus, map[string]any{"to": "done", "stage": "released", "event": "land"}, false},
		{"到期", Overdue, nil, true},
		{"执行者不可用", WorkerDown, nil, true},
		{"上限满了", LimitFull, nil, true},
		{"自升级失败", OnlineFailed, nil, true},
		{"定时任务失败", ScheduleFail, nil, true},
		{"远程机器记录失败", HostRecord, nil, true},
		{"负责人接不住转来的任务", TaskAssigned, nil, true},
		{"未知种类", "other", nil, false},
	}
	for _, c := range cases {
		if got := SecretaryAct(c.kind, c.body); got != c.want {
			t.Errorf("%s：SecretaryAct(%s, %v) = %v，应为 %v", c.name, c.kind, c.body, got, c.want)
		}
	}
}

// 秘书的要处理只收四类：其余落到秘书的降为知会（仍落库可查），负责人收的不降；积压只数四类（overdue 本就不计积压）。
func TestSecretaryInbox(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	for _, kind := range []string{"ask", "stuck", "beyond", "notify"} {
		emit(t, db, Event{Kind: LeaderEscalate, Target: Secretary, Body: map[string]any{"kind": kind}})
	}
	emit(t, db, Event{Kind: LeaderEscalate, Target: Secretary, Level: Info, Body: map[string]any{"kind": "cross"}})
	emit(t, db, Event{Kind: LeaderEscalate, Target: Secretary, Level: Act, Body: map[string]any{"kind": "cross"}})
	emit(t, db, Event{Kind: Overdue, Target: Secretary})
	emit(t, db, Event{Kind: TaskStatus, Target: Secretary, Body: map[string]any{"to": "done", "by": "a1"}})
	emit(t, db, Event{Kind: TaskStatus, Target: "a1", Body: map[string]any{"to": "done", "by": "worker"}})
	emit(t, db, Event{Kind: LeaderEscalate, Target: "a1", Body: map[string]any{"kind": "cross"}})

	act, _ := Pending(ctx, db, Secretary, false, 50)
	all, _ := Pending(ctx, db, Secretary, true, 50)
	if len(act) != 5 || len(all) != 8 {
		t.Fatalf("秘书要处理应 5 条（ask、stuck、beyond、notify、overdue），连知会共 8 条：%d / %d", len(act), len(all))
	}
	for _, r := range act {
		if r.Kind == TaskStatus || strings.Contains(string(r.Body), "cross") {
			t.Fatalf("完成回执、cross 不该进秘书的要处理：%+v", r)
		}
	}
	if lead, _ := Pending(ctx, db, "a1", false, 50); len(lead) != 2 {
		t.Fatalf("负责人收的完成回执与协作请求应仍要处理：%+v", lead)
	}
	bl, err := Backlogs(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for _, b := range bl {
		got[b.Target] = b.Count
	}
	if got[Secretary] != 4 || got["a1"] != 2 {
		t.Fatalf("积压：秘书应 4（不含 overdue 与知会）、a1 应 2：%+v", bl)
	}
}

// 旧库里按旧规则以要处理落给秘书的普通回执（cross、完成回执），Reclassify 后降为知会、正文不变；
// 卡住升级、已确认的、负责人收的不动；积压与取走只剩真要处理的。
func TestReclassify(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	insert := func(kind, target, body string, acked bool) {
		t.Helper()
		var ack any
		if acked {
			ack = 1
		}
		exec(t, db, `INSERT INTO events (at, updated_at, kind, level, key, target, body, acked_at) VALUES (1, 1, ?, 'act', '', ?, ?, ?)`,
			kind, target, body, ack)
	}
	insert(LeaderEscalate, Secretary, `{"kind":"cross","note":"t866确认工作已闭合，回交t862"}`, false)
	insert(TaskStatus, Secretary, `{"from":"running","to":"done","by":"a5"}`, false)
	insert(LeaderEscalate, Secretary, `{"kind":"stuck","note":"卡了三次"}`, false)
	insert(TaskStatus, Secretary, `{"to":"blocked"}`, false)
	insert(TaskStatus, Secretary, `{"to":"done"}`, true)
	insert(LeaderEscalate, "a1", `{"kind":"cross","note":"要配合"}`, false)

	if a, _ := Pending(ctx, db, Secretary, false, 50); len(a) != 4 {
		t.Fatalf("前提：旧库秘书要处理 4 条：%+v", a)
	}
	n, err := Reclassify(ctx, db)
	if err != nil || n != 2 {
		t.Fatalf("应降 2 条：%d %v", n, err)
	}
	act, _ := Pending(ctx, db, Secretary, false, 50)
	if len(act) != 2 || !strings.Contains(string(act[0].Body), "卡了三次") || !strings.Contains(string(act[1].Body), "blocked") {
		t.Fatalf("秘书要处理只剩 stuck 与受阻：%+v", act)
	}
	all, _ := Pending(ctx, db, Secretary, true, 50)
	if len(all) != 4 || !strings.Contains(string(all[0].Body), "回交t862") || all[0].Level != Info {
		t.Fatalf("降级的回执仍在、正文不变：%+v", all)
	}
	if lead, _ := Pending(ctx, db, "a1", false, 50); len(lead) != 1 {
		t.Fatalf("负责人收的协作请求不动：%+v", lead)
	}
	bl, _ := Backlogs(ctx, db)
	got := map[string]int{}
	for _, b := range bl {
		got[b.Target] = b.Count
	}
	if got[Secretary] != 2 || got["a1"] != 1 {
		t.Fatalf("积压：秘书 2、a1 1：%+v", bl)
	}
	if taken, _ := Take(ctx, db, Secretary, false); len(taken) != 2 {
		t.Fatalf("取走只剩 2 条：%+v", taken)
	}
	if n, err := Reclassify(ctx, db); err != nil || n != 0 {
		t.Fatalf("再跑一次不再降：%d %v", n, err)
	}

	// 负责人接不住、转给秘书的：交给它拆的任务仍要处理，完成回执只知会。
	insert(TaskAssigned, "a2", `{"title":"拆这件"}`, false)
	insert(TaskStatus, "a2", `{"to":"done","by":"worker"}`, false)
	var ids []int64
	rows, _ := db.Query(`SELECT id FROM events WHERE target = 'a2'`)
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	if n, err := Retarget(ctx, db, ids, "a2", Secretary); err != nil || n != 2 {
		t.Fatalf("应转 2 条：%d %v", n, err)
	}
	var assigned, done string
	db.QueryRow(`SELECT level FROM events WHERE id = ?`, ids[0]).Scan(&assigned)
	db.QueryRow(`SELECT level FROM events WHERE id = ?`, ids[1]).Scan(&done)
	if assigned != Act || done != Info {
		t.Fatalf("转给秘书后：任务应要处理、完成回执应知会：%s %s", assigned, done)
	}
}

func TestLegacyShippedEvent(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	// 模拟已有事件：级别和标签已经存下，读取不重新按 kind 分类。
	emit(t, db, Event{Kind: LeaderEscalate, Target: Secretary, Level: Info,
		Body: map[string]any{"from": "a1", "kind": "shipped", "label": "已上线（里程碑）", "note": "请转告用户"}})
	rows, err := Pending(ctx, db, Secretary, true, 10)
	if err != nil || len(rows) != 1 || rows[0].Level != Info {
		t.Fatalf("旧上报应保留已存的级别：%+v %v", rows, err)
	}
	if got := Summary(rows[0], nil); got != "未登记负责人（a1） 上报（已上线（里程碑））：请转告用户" {
		t.Errorf("旧上报应使用已存的标签和说明：%q", got)
	}
	if rows, err := Pending(ctx, db, Secretary, false, 10); err != nil || len(rows) != 0 {
		t.Fatalf("旧知会事件不应变成要处理：%+v %v", rows, err)
	}
}

func TestSummary(t *testing.T) {
	if s := Summary(Row{Kind: LeaderEscalate, Body: []byte(`{"from":"a1","label":"无法解决","note":"证书要用户签"}`)}, nil); s != "未登记负责人（a1） 上报（无法解决）：证书要用户签" {
		t.Errorf("上报 Summary = %q", s)
	}
	body, _ := json.Marshal(map[string]any{
		"text": "部门 o2 的每部门要点已 8/7 条（满了找部门负责人）：先合并",
		"next": "atrium org show o2",
	})
	if s := Summary(Row{Kind: LimitFull, Body: body}, nil); s != "部门 o2 的每部门要点已 8/7 条（满了找部门负责人）：先合并 · atrium org show o2" {
		t.Errorf("上限 Summary = %q", s)
	}
	body, _ = json.Marshal(map[string]any{"from": "running", "to": "blocked", "title": "修登录"})
	if s := Summary(Row{Kind: TaskStatus, Body: body}, nil); s != "running → blocked「修登录」" {
		t.Errorf("Summary = %q", s)
	}
	body, _ = json.Marshal(map[string]any{"from": "running", "to": "done", "stage": "released", "title": "修登录", "note": "已上线（v1.2.3）"})
	if s := Summary(Row{Kind: TaskStatus, Body: body}, nil); s != "running → done（released）「修登录」 · 已上线（v1.2.3）" {
		t.Errorf("Summary = %q", s)
	}
	body, _ = json.Marshal(map[string]any{"text": "卡住，等处理", "held_ms": 31 * 60000, "next": "atrium task show t1"})
	if s := Summary(Row{Kind: Overdue, Body: body}, nil); s != "到期：卡住，等处理（已 31 分钟） · atrium task show t1" {
		t.Errorf("Summary = %q", s)
	}
	if s := Summary(Row{Kind: TaskAssigned, Body: []byte(`{"title":"拆分任务分派任务"}`)}, nil); s != "交给你去拆「拆分任务分派任务」：拆子任务、分派任务、收尾" {
		t.Errorf("TaskAssigned Summary = %q", s)
	}
	if s := Summary(Row{Kind: TaskAssigned, Body: []byte(`{"title":"拆分任务分派任务","tell":"也要改网页"}`)}, nil); s != "交给你拆的「拆分任务分派任务」有补充：也要改网页" {
		t.Errorf("带补充的 TaskAssigned Summary = %q", s)
	}
	body, _ = json.Marshal(map[string]any{"target": "kimi@h3", "reason": "没登录", "next": "登录、装好或升级运行环境后 atrium workers edit --clear kimi@h3"})
	if s := Summary(Row{Kind: WorkerDown, Body: body}, nil); s != "kimi@h3 不可用：没登录 · 登录、装好或升级运行环境后 atrium workers edit --clear kimi@h3" {
		t.Errorf("WorkerDown Summary = %q", s)
	}
	if l := Line(Row{ID: 7, Task: "t2", Kind: "x", Count: 3}, nil); l != "#7 t2 x （合并 3 次）" {
		t.Errorf("Line = %q", l)
	}
}

func TestRecipientMergeLeaseAck(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	exec(t, db, `INSERT INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0)`)
	exec(t, db, `INSERT INTO departments (id, parent, name, leader, created_at, updated_at) VALUES ('o1', NULL, '公司', 'a1', 0, 0)`)
	exec(t, db, `INSERT INTO departments (id, parent, name, created_at, updated_at) VALUES ('o2', 'o1', '运行时', 0, 0)`)
	exec(t, db, `INSERT INTO departments (id, parent, name, created_at, updated_at) VALUES ('o3', NULL, '无人', 0, 0)`)
	exec(t, db, `INSERT INTO tasks (id, department, title, status, created_at, updated_at) VALUES ('t1', 'o2', 'x', 'running', 0, 0)`)

	// 同一任务的状态变化合并成一条，正文与级别随最新的：等验收之后已合入，旧的要处理不再叫人。
	emit(t, db, Event{Kind: TaskStatus, Task: "t1", Dept: "o2", Body: map[string]any{"to": "running", "accept_by": "leader"}})
	emit(t, db, Event{Kind: TaskStatus, Task: "t1", Dept: "o2", Body: map[string]any{"to": "running", "stage": "merged", "event": "land"}})
	rows, err := Pending(ctx, db, "a1", true, 10)
	if err != nil || len(rows) != 1 || rows[0].Count != 2 || rows[0].Level != Info || rows[0].Target != "a1" {
		t.Fatalf("合并后应只知会：%+v %v", rows, err)
	}
	emit(t, db, Event{Kind: TaskStatus, Task: "t1", Dept: "o2", Body: map[string]any{"to": "blocked"}})
	rows, err = Pending(ctx, db, "a1", true, 10)
	if err != nil || len(rows) != 1 || rows[0].Count != 3 || rows[0].Level != Act {
		t.Fatalf("合并：%+v %v", rows, err)
	}
	// 知会不进缺省的 wait。
	emit(t, db, Event{Kind: "note", Dept: "o2"})
	got, err := Take(ctx, db, "a1", false)
	if err != nil || len(got) != 1 || got[0].ID != rows[0].ID || got[0].LeasedUntil == nil {
		t.Fatalf("Take: %+v %v", got, err)
	}
	// 租约内不重投；租约中的不再合并，新发生的另起一条。
	if again, _ := Take(ctx, db, "a1", false); len(again) != 0 {
		t.Fatalf("租约内重投了：%+v", again)
	}
	emit(t, db, Event{Kind: TaskStatus, Task: "t1", Dept: "o2", Body: map[string]any{"to": "failed"}})
	fresh, _ := Take(ctx, db, "a1", false)
	if len(fresh) != 1 || fresh[0].ID == got[0].ID {
		t.Fatalf("租约中的不应被合并：%+v", fresh)
	}
	// 租约到期重投。
	exec(t, db, `UPDATE events SET leased_until = 1 WHERE id = ?`, got[0].ID)
	if again, _ := Take(ctx, db, "a1", false); len(again) != 1 || again[0].ID != got[0].ID {
		t.Fatalf("到期没重投：%+v", again)
	}
	// 确认：负责人只能确认自己的。
	res, err := Ack(ctx, db, []int64{got[0].ID, 999}, "a1", "a1")
	if err != nil || len(res.Acked) != 1 || len(res.Missing) != 1 {
		t.Fatalf("Ack: %+v %v", res, err)
	}
	if res, _ := Ack(ctx, db, []int64{got[0].ID}, "", "u1"); len(res.Already) != 1 {
		t.Fatalf("重复确认：%+v", res)
	}
	emit(t, db, Event{Kind: Overdue, Target: Secretary})
	if res, _ := Ack(ctx, db, []int64{fresh[0].ID + 1}, "a1", "a1"); len(res.Missing) != 1 {
		t.Fatalf("负责人确认了别人的事件：%+v", res)
	}
	if seen, _ := Seen(ctx, db, "a1", "task:t1"); !seen {
		t.Fatal("Seen 应为真")
	}
	bl, err := Backlogs(ctx, db)
	if err != nil || len(bl) != 1 || bl[0].Target != "a1" || bl[0].Count != 1 {
		t.Fatalf("Backlogs（不含 overdue 与已确认）：%+v %v", bl, err)
	}
}

func TestWaitWakesAndBatches(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	go func() {
		time.Sleep(200 * time.Millisecond)
		emit(t, db, Event{Kind: Overdue, Target: Secretary, Body: map[string]any{"n": 1}})
		time.Sleep(100 * time.Millisecond)
		emit(t, db, Event{Kind: Overdue, Target: Secretary, Body: map[string]any{"n": 2}})
	}()
	start := time.Now()
	rows, err := Wait(ctx, db, WaitOpts{Target: Secretary, Timeout: 5 * time.Second, Batch: 500 * time.Millisecond})
	if err != nil || len(rows) != 2 {
		t.Fatalf("Wait: %+v %v", rows, err)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("Wait 醒得太慢：%v", d)
	}
	rows, err = Wait(ctx, db, WaitOpts{Target: Secretary, Timeout: 0})
	if err != nil || len(rows) != 0 {
		t.Fatalf("超时应返回空：%+v %v", rows, err)
	}
}

func TestListen(t *testing.T) {
	Listen("secretary", "测试", time.Minute, false)
	l := Listening("secretary")
	if l == nil || l.Via != "测试" {
		t.Fatalf("Listening = %+v", l)
	}
	Listen("secretary", "", 0, true)
	if Listening("secretary") != nil {
		t.Fatal("停了还在听")
	}
}

func TestSubscriber(t *testing.T) {
	cases := []struct {
		actor api.Actor
		as    string
		want  string
		code  string
	}{
		{api.Actor{ID: "u1", Kind: "user"}, "", Secretary, ""},
		{api.Actor{ID: "u1", Kind: "user"}, "a3", "a3", ""},
		{api.Actor{ID: "u1", Kind: "user"}, "o1", "", "usage"},
		{api.Actor{ID: "a1", Kind: "leader"}, "", "a1", ""},
		{api.Actor{ID: "a1", Kind: "leader"}, "a2", "", "forbidden"},
		{api.Actor{ID: "a1", Kind: "leader"}, "secretary", "", "forbidden"},
		{api.Actor{ID: "h2", Kind: "host"}, "", "", "forbidden"},
	}
	for _, c := range cases {
		req := &api.Req{Request: httptest.NewRequest("GET", "/api/events/wait?as="+c.as, nil), Actor: c.actor}
		got, err := subscriber(req)
		var ae *api.Error
		code := ""
		if errors.As(err, &ae) {
			code = ae.Code
		}
		if got != c.want || code != c.code {
			t.Errorf("%+v as=%q：得到 %q %q，应为 %q %q", c.actor, c.as, got, code, c.want, c.code)
		}
	}
}

func TestPrune(t *testing.T) {
	db := openDB(t)
	ctx := context.Background()
	const before = 1_000_000
	cases := []struct {
		name    string
		level   string
		updated int64
		acked   bool
		gone    bool
	}{
		{"已确认·过期", Act, before - 1, true, true},
		{"已确认·正好到点", Act, before, true, false},
		{"已确认·没过期", Act, before + 1, true, false},
		{"知会·没确认·过期", Info, before - 1, false, true},
		{"知会·已确认·过期", Info, before - 1, true, true},
		{"知会·没确认·没过期", Info, before + 1, false, false},
		{"要处理·没确认·过期", Act, before - 1, false, false},
		{"要处理·没确认·没过期", Act, before + 1, false, false},
	}
	for i, c := range cases {
		var acked any
		if c.acked {
			acked = c.updated
		}
		exec(t, db, `INSERT INTO events (id, at, updated_at, kind, level, key, target, acked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			i+1, c.updated, c.updated, Overdue, c.level, "k"+strconv.Itoa(i+1), "a1", acked)
	}
	n, err := Prune(ctx, db, before)
	if err != nil {
		t.Fatal(err)
	}
	want := 0
	for i, c := range cases {
		if c.gone {
			want++
		}
		seen, err := Seen(ctx, db, "a1", "k"+strconv.Itoa(i+1))
		if err != nil {
			t.Fatal(err)
		}
		if seen == c.gone {
			t.Errorf("%s: 删了=%v，应为 %v", c.name, !seen, c.gone)
		}
	}
	if n != int64(want) {
		t.Errorf("删了 %d 条，应为 %d", n, want)
	}
}
