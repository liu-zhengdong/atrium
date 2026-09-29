package events

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"path/filepath"
	"slices"
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
		{"用户放进落地·等负责人验收", TaskStatus, map[string]any{"to": "running", "stage": "accept", "accept_by": "leader", "by": "u1"}, Act},
		{"关卡过了直接完成", TaskStatus, map[string]any{"to": "done", "stage": "gate", "event": "gate_pass", "by": "gates"}, Act},
		{"已上线", TaskStatus, map[string]any{"to": "done", "stage": "released", "event": "land", "by": "release"}, Act},
		{"负责人验收通过", TaskStatus, map[string]any{"to": "done", "stage": "accept", "event": "accept", "by": "a1"}, Act},
		// 用户本人做的完成只知会：task set --status done、task accept。
		{"用户标完成", TaskStatus, map[string]any{"to": "done", "event": "set", "by": "u1"}, Info},
		{"用户验收通过", TaskStatus, map[string]any{"to": "done", "stage": "accept", "event": "accept", "by": "u1"}, Info},
		// 落地的中间步骤与过程只知会。
		{"已合入等发版", TaskStatus, map[string]any{"to": "running", "stage": "merged", "event": "land", "by": "merge"}, Info},
		{"拉起", TaskStatus, map[string]any{"to": "running", "by": "dispatch"}, Info},
		{"用户取消", TaskStatus, map[string]any{"to": "cancelled", "by": "u1"}, Info},
		{"无正文", TaskStatus, nil, Info},
		// 非任务事件：上线失败、到期、上限、上交
		{"自升级上线失败", OnlineFailed, nil, Act},
		{"持球到期", Overdue, nil, Act},
		{"上限满了", LimitFull, map[string]any{"key": "points"}, Act},
		{"负责人上交·卡住", LeaderEscalate, map[string]any{"kind": "stuck"}, Act},
		{"负责人上交·跨部门", LeaderEscalate, map[string]any{"kind": "cross"}, Act},
		{"负责人上交·已上线", LeaderEscalate, map[string]any{"kind": "shipped"}, Info},
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
	if k := KeyOf(Event{Kind: Overdue, Task: "t3"}); k != "" {
		t.Errorf("overdue 缺省不合并，得到 %q", k)
	}
	if k := KeyOf(Event{Kind: LimitFull, Dept: "o2", Body: map[string]any{"key": "points"}}); k != "limit:o2:points" {
		t.Errorf("LimitFull KeyOf = %q", k)
	}
}

func TestRoute(t *testing.T) {
	st := func(to, stage string) map[string]any { return map[string]any{"to": to, "stage": stage} }
	type d = Delivery
	cases := []struct {
		name, owner, leader string
		body                map[string]any
		want                []Delivery
	}{
		// 结果：处理人按 LevelOf，负责人（不是处理人时）知会。
		{"用户处理·合入完成·有负责人", "u1", "a1", st("done", "merged"), []d{{Secretary, Act}, {"a1", Info}}},
		{"用户处理·合入完成·无负责人", "u1", "", st("done", "merged"), []d{{Secretary, Act}}},
		{"秘书处理·已合入等发版只知会", Secretary, "a1", map[string]any{"to": "running", "stage": "merged", "event": "land"}, []d{{Secretary, Info}, {"a1", Info}}},
		{"用户处理·用户验收通过只知会", "u1", "a1", map[string]any{"to": "done", "stage": "accept", "event": "accept", "by": "u1"}, []d{{Secretary, Info}, {"a1", Info}}},
		{"用户处理·用户标受阻照旧要处理", "u1", "", map[string]any{"to": "blocked", "by": "u1"}, []d{{Secretary, Act}}},
		// 等验收：投验收人，要处理；负责人另收知会。
		{"等用户验收·有负责人", "a1", "a1", map[string]any{"to": "running", "stage": "accept", "accept_by": "user"}, []d{{Secretary, Act}, {"a1", Info}}},
		{"等负责人验收", "u1", "a1", map[string]any{"to": "running", "stage": "accept", "accept_by": "leader"}, []d{{"a1", Act}}},
		{"等负责人验收·没有负责人投秘书", "u1", "", map[string]any{"to": "running", "stage": "accept", "accept_by": "leader"}, []d{{Secretary, Act}}},
		{"秘书处理·上线", Secretary, "a1", st("done", "released"), []d{{Secretary, Act}, {"a1", Info}}},
		{"秘书处理·失败·无负责人", Secretary, "", st("failed", ""), []d{{Secretary, Act}}},
		{"负责人处理·受阻·本部门", "a1", "a1", st("blocked", "merge_queue"), []d{{"a1", Act}}},
		{"负责人处理·完成·下属部门", "a1", "a3", st("done", "gate"), []d{{"a1", Act}, {"a3", Info}}},
		{"负责人处理·失败·无负责人", "a2", "", st("failed", ""), []d{{"a2", Act}}},
		// 运行时建的：按部门找负责人，成功只知会，失败、受阻要处理。
		{"运行时·完成·有负责人", "gates", "a1", st("done", "review"), []d{{"a1", Info}}},
		{"运行时·受阻·有负责人", "gates", "a1", st("blocked", "gate"), []d{{"a1", Act}}},
		{"运行时·失败·无负责人", "", "", st("failed", ""), []d{{Secretary, Act}}},
		// 过程：只知会负责人，不投秘书。
		{"用户处理·入队·有负责人", "u1", "a1", st("queued", ""), []d{{"a1", Info}}},
		{"用户处理·拉起·无负责人", "u1", "", st("running", ""), nil},
		{"秘书处理·交回一次", Secretary, "a1", st("queued", ""), []d{{"a1", Info}}},
		{"负责人处理·取消·本部门", "a1", "a1", st("cancelled", ""), []d{{"a1", Info}}},
		{"运行时·入队·无负责人", "gates", "", st("queued", ""), nil},
	}
	for _, c := range cases {
		if got := Route(c.owner, c.leader, TaskStatus, c.body); !slices.Equal(got, c.want) {
			t.Errorf("%s：Route = %v，应为 %v", c.name, got, c.want)
		}
	}
}

func TestEmitTask(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	exec(t, db, `INSERT INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0)`)
	exec(t, db, `INSERT INTO departments (id, parent, name, leader, created_at, updated_at) VALUES ('o1', NULL, '公司', 'a1', 0, 0)`)
	exec(t, db, `INSERT INTO tasks (id, department, title, status, created_at, updated_at) VALUES ('t1', 'o1', 'x', 'running', 0, 0)`)
	emitTask := func(owner, to, by string) {
		t.Helper()
		err := db.Tx(ctx, func(tx *sql.Tx) error {
			return EmitTask(ctx, tx, owner, Event{Kind: TaskStatus, Task: "t1", Dept: "o1", Body: map[string]any{"to": to, "by": by}, By: by})
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	emitTask("u1", "queued", "u1")
	emitTask("u1", "running", "dispatch")
	emitTask("u1", "done", "merge")
	sec, _ := Pending(ctx, db, Secretary, true, 10)
	lead, _ := Pending(ctx, db, "a1", true, 10)
	if len(sec) != 1 || sec[0].Level != Act || !strings.Contains(string(sec[0].Body), "done") {
		t.Fatalf("秘书应只收一条要处理的结果：%+v", sec)
	}
	if len(lead) != 1 || lead[0].Level != Info || lead[0].Count != 3 {
		t.Fatalf("负责人应收一条合并的知会：%+v", lead)
	}
	Ack(ctx, db, []int64{sec[0].ID, lead[0].ID}, "", "u1")

	// 用户本人做的完成照样投秘书（按身份比对，u1 不是 secretary），只知会。
	emitTask("u1", "done", "u1")
	sec, _ = Pending(ctx, db, Secretary, true, 10)
	if len(sec) != 1 || sec[0].Level != Info {
		t.Fatalf("用户本人做的完成，秘书应只收知会：%+v", sec)
	}
	Ack(ctx, db, []int64{sec[0].ID}, "", "u1")

	// 一次操作引出的事件不投给做这次操作的身份本人：秘书停下、负责人取消，各自不收。
	for _, c := range []struct{ owner, to, by, self, other string }{
		{Secretary, "blocked", Secretary, Secretary, "a1"},
		{"a2", "failed", "a1", "a1", "a2"},
	} {
		emitTask(c.owner, c.to, c.by)
		self, _ := Pending(ctx, db, c.self, true, 10)
		other, _ := Pending(ctx, db, c.other, true, 10)
		if len(self) != 0 || len(other) != 1 {
			t.Fatalf("%s 做的 %s：本人收到 %+v，另一位收到 %+v", c.by, c.to, self, other)
		}
		Ack(ctx, db, []int64{other[0].ID}, "", "u1")
	}
}

func TestSummary(t *testing.T) {
	if s := Summary(Row{Kind: LeaderEscalate, Body: []byte(`{"from":"a1","label":"搞不定","note":"证书要用户签"}`)}); s != "a1 上交（搞不定）：证书要用户签" {
		t.Errorf("上交 Summary = %q", s)
	}
	body, _ := json.Marshal(map[string]any{
		"text": "部门 o2 的每部门要点已 8/7 条（满了找部门负责人）：先合并",
		"next": "atrium org show o2",
	})
	if s := Summary(Row{Kind: LimitFull, Body: body}); s != "部门 o2 的每部门要点已 8/7 条（满了找部门负责人）：先合并 · atrium org show o2" {
		t.Errorf("上限 Summary = %q", s)
	}
	body, _ = json.Marshal(map[string]any{"from": "running", "to": "blocked", "title": "修登录"})
	if s := Summary(Row{Kind: TaskStatus, Body: body}); s != "running → blocked「修登录」" {
		t.Errorf("Summary = %q", s)
	}
	body, _ = json.Marshal(map[string]any{"from": "running", "to": "done", "stage": "released", "title": "修登录", "note": "已上线（v1.2.3）"})
	if s := Summary(Row{Kind: TaskStatus, Body: body}); s != "running → done（released）「修登录」 · 已上线（v1.2.3）" {
		t.Errorf("Summary = %q", s)
	}
	body, _ = json.Marshal(map[string]any{"text": "卡住，等处理", "held_ms": 31 * 60000, "next": "atrium task show t1"})
	if s := Summary(Row{Kind: Overdue, Body: body}); s != "到期：卡住，等处理（已 31 分钟） · atrium task show t1" {
		t.Errorf("Summary = %q", s)
	}
	if s := Summary(Row{Kind: TaskAssigned, Body: []byte(`{"title":"拆活派活"}`)}); s != "交给你去拆「拆活派活」：拆子任务、派活、收尾" {
		t.Errorf("TaskAssigned Summary = %q", s)
	}
	if l := Line(Row{ID: 7, Task: "t2", Kind: "x", Count: 3}); l != "#7 t2 x （合并 3 次）" {
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

	// 同一任务的状态变化合并成一条，级别取高。
	emit(t, db, Event{Kind: TaskStatus, Task: "t1", Dept: "o2", Body: map[string]any{"to": "blocked"}})
	emit(t, db, Event{Kind: TaskStatus, Task: "t1", Dept: "o2", Body: map[string]any{"to": "queued"}})
	rows, err := Pending(ctx, db, "a1", true, 10)
	if err != nil || len(rows) != 1 || rows[0].Count != 2 || rows[0].Level != Act || rows[0].Target != "a1" {
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
