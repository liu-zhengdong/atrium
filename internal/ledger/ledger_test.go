package ledger

import (
	"context"
	"errors"
	"maps"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/org"
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

func code(err error) string {
	var ae *api.Error
	if errors.As(err, &ae) {
		return ae.Code
	}
	return ""
}

func TestLedgerLifecycle(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	a, err := Add(ctx, db, NewTask{Title: "  根  "}, "u1")
	if err != nil || a.ID != "t1" || a.Title != "根" || a.Status != Todo || a.Priority != Normal {
		t.Fatalf("add: %+v %v", a, err)
	}
	b, _ := Add(ctx, db, NewTask{Title: "子", Parent: "t1"}, "u1")
	c, err := Add(ctx, db, NewTask{Title: "后", Parent: "t1", After: []string{b.ID}}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Add(ctx, db, NewTask{Title: "x", After: []string{"t99"}}, "u1"); code(err) != "not_found" {
		t.Fatalf("不存在的依赖应 404，got %v", err)
	}
	if _, err := Add(ctx, db, NewTask{Title: "x", Skill: "nosuch"}, "u1"); code(err) != "not_found" {
		t.Fatalf("没登记的技能应 404，got %v", err)
	}
	if _, err := Add(ctx, db, NewTask{Title: "x", Org: "o1"}, "u1"); code(err) != "not_found" {
		t.Fatalf("不存在的部门应 404，got %v", err)
	}
	if _, err := Add(ctx, db, NewTask{Title: " "}, "u1"); code(err) != "usage" {
		t.Fatalf("空标题应拒绝，got %v", err)
	}
	if _, err := Add(ctx, db, NewTask{Title: "x", Priority: "high"}, "u1"); code(err) != "usage" {
		t.Fatalf("非法优先级应拒绝，got %v", err)
	}
	// 依赖成环要拒绝，且不留半截改动。
	if _, err := Edit(ctx, db, b.ID, Patch{After: &[]string{c.ID}}, "u1"); code(err) != "usage" {
		t.Fatalf("成环应拒绝，got %v", err)
	}
	if deps, _ := Deps(ctx, db, b.ID); len(deps) != 0 {
		t.Fatalf("回滚后 b 不该有依赖：%v", deps)
	}
	// 走一遍：派 → 起 → 交付 → 关卡不过交回 ×2 → 第三次转受阻。
	for _, ev := range []EventKind{Enqueue, Start, ExitOK, Bounce, Start, ExitOK, Bounce, Start, ExitOK} {
		if _, err := Apply(ctx, db, b.ID, Event{Kind: ev}, "dispatch", ""); err != nil {
			t.Fatalf("%s: %v", ev, err)
		}
	}
	got, err := Apply(ctx, db, b.ID, Event{Kind: Bounce}, "gates", "第三次不过")
	if err != nil || got.Status != Blocked {
		t.Fatalf("第三次交回应受阻：%+v %v", got, err)
	}
	if _, err := Apply(ctx, db, b.ID, Event{Kind: Start}, "x", ""); code(err) != "conflict" {
		t.Fatalf("非法转移应 409，got %v", err)
	}
	// 人工改回 todo 后交回次数重新算。
	if _, err := Apply(ctx, db, b.ID, Event{Kind: Set, To: Todo}, "u1", ""); err != nil {
		t.Fatal(err)
	}
	if n, _ := Bounces(ctx, db, b.ID); n != 0 {
		t.Fatalf("bounces = %d", n)
	}
	done, err := Apply(ctx, db, b.ID, Event{Kind: Set, To: Done}, "u1", "")
	if err != nil || done.FinishedAt == nil {
		t.Fatalf("完成应记结束时间：%+v %v", done, err)
	}
	// 状态变化都发了事件。
	var n int
	db.QueryRow(`SELECT count(*) FROM events WHERE kind = 'task.status' AND task = ?`, b.ID).Scan(&n)
	if n == 0 {
		t.Fatal("没发事件")
	}
	// b 完成后 c 就绪。
	deps, _ := Deps(ctx, db, c.ID)
	if ready, _ := Ready(Todo, deps); !ready {
		t.Fatalf("c 应就绪：%v", deps)
	}
	sub, _ := Subtree(ctx, db, a.ID)
	if tree := BuildTree(sub); tree.Summary.Total != 2 || tree.Summary.Counts[Done] != 1 {
		t.Fatalf("汇总 %+v", tree.Summary)
	}
	if err := Note(ctx, db, c.ID, "u1", "记一笔"); err != nil {
		t.Fatal(err)
	}
	if h, _ := History(ctx, db, c.ID, 5); len(h) != 2 || h[1].Kind != "note" {
		t.Fatalf("经历 %+v", h)
	}
	list, _ := List(ctx, db, Filter{})
	if len(list) != 2 { // b 完成了，列 a、c
		t.Fatalf("ls 缺省只列没结束的：%d", len(list))
	}
}

// 结果投处理人（缺省派活的人）：秘书派的失败要处理地投秘书，过程不投秘书；--owner 改投指定的人；周期任务记建周期任务的人。
func TestResultGoesToOwner(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	if _, err := db.Exec(`INSERT INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0), ('a2', 'leader', '乙', 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO departments (id, name, leader, created_at, updated_at) VALUES ('o1', '公司', 'a1', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	x, _ := Add(ctx, db, NewTask{Title: "秘书派的", Org: "o1"}, "u1")
	y, _ := Add(ctx, db, NewTask{Title: "周期", Org: "o1", By: "a1"}, "s1")
	z, err := Add(ctx, db, NewTask{Title: "交给乙", Org: "o1", Owner: "a2"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Add(ctx, db, NewTask{Title: "坏", Owner: "a9"}, "u1"); code(err) != "not_found" || !strings.HasPrefix(err.Error(), "--owner") {
		t.Fatalf("处理人不存在应报 --owner：%v", err)
	}
	for _, c := range []struct {
		id   string
		want Parties
	}{{x.ID, Parties{"u1", "u1"}}, {y.ID, Parties{"a1", "a1"}}, {z.ID, Parties{"u1", "a2"}}} {
		if p, err := PartiesOf(ctx, db, c.id); err != nil || p != c.want {
			t.Fatalf("PartiesOf(%s) = %+v %v，应为 %+v", c.id, p, err, c.want)
		}
	}
	for _, id := range []string{x.ID, z.ID} {
		for _, k := range []EventKind{Enqueue, Start, ExitFail} {
			if _, err := Apply(ctx, db, id, Event{Kind: k}, "dispatch", "额度用尽"); err != nil {
				t.Fatal(err)
			}
		}
	}
	got := map[string]string{}
	rows, _ := db.Query(`SELECT task || ' ' || target, level || ' ' || count FROM events ORDER BY id`)
	for rows.Next() {
		var k, v string
		rows.Scan(&k, &v)
		got[k] = v
	}
	rows.Close()
	want := map[string]string{
		x.ID + " secretary": "act 1", x.ID + " a1": "info 3", // 秘书收失败，负责人收合并的知会
		z.ID + " a2": "act 1", z.ID + " a1": "info 3", // 处理人乙收失败，秘书不收
	}
	if !maps.Equal(got, want) {
		t.Fatalf("事件 = %v，应为 %v", got, want)
	}
}

func TestDraftCap(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	for i := 0; i < org.MaxDrafts; i++ {
		d, err := Add(ctx, db, NewTask{Title: "草稿", Draft: true}, "secretary")
		if err != nil || d.Status != Draft {
			t.Fatalf("第 %d 件草稿：%+v %v", i+1, d, err)
		}
	}
	if _, err := Add(ctx, db, NewTask{Title: "满了", Draft: true}, "secretary"); code(err) != "limit" {
		t.Fatalf("草稿满了应报 limit，got %v", err)
	}
	todo, err := Add(ctx, db, NewTask{Title: "待派"}, "secretary")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(ctx, db, todo.ID, Event{Kind: Set, To: Draft}, "secretary", ""); code(err) != "limit" {
		t.Fatalf("满了不能退回草稿，got %v", err)
	}
	if _, err := Apply(ctx, db, "t1", Event{Kind: Set, To: Todo}, "secretary", ""); err != nil {
		t.Fatal(err)
	}
	if got, err := Apply(ctx, db, todo.ID, Event{Kind: Set, To: Draft}, "secretary", ""); err != nil || got.Status != Draft {
		t.Fatalf("腾出位置后可以退回草稿：%+v %v", got, err)
	}
}
