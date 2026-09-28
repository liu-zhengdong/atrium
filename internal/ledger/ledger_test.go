package ledger

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

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
