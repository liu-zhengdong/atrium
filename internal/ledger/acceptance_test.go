package ledger

import (
	"context"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
	"path/filepath"
	"testing"
)

func TestAcceptanceLifecycle(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { db.Close() }()
	// 模拟升级前的库，保留文字历史，不自动推断决定。
	if _, err := db.Exec(`DROP TABLE task_acceptance`); err != nil {
		t.Fatal(err)
	}
	task, err := Add(ctx, db, NewTask{Title: "阶段产物"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if err := Note(ctx, db, task.ID, "u1", "暂缓，不合入"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if a, err := AcceptanceOf(ctx, db, task.ID); err != nil || a != nil {
		t.Fatalf("旧文字不能自动转决定：%+v %v", a, err)
	}
	if _, err := Decide(ctx, db, task.ID, "hold", "目标未完成", "u1"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range []Event{{Kind: Set, To: Todo}, {Kind: Enqueue}, {Kind: Start}, {Kind: ExitOK}, {Kind: GatePass, Land: StageMerge}, {Kind: Bounce}, {Kind: Start}, {Kind: ExitOK}, {Kind: GatePass, NeedReview: true}, {Kind: ReviewPass, Land: StageMerge}} {
		if _, err := Apply(ctx, db, task.ID, ev, "runtime", ""); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := Get(ctx, db, task.ID)
	if got.Stage != StageAccept {
		t.Fatalf("重派/交回/审阅应等验收：%+v", got)
	}
	for _, ev := range []Event{{Kind: Set, To: Done}, {Kind: Land, Land: StageMerged, Final: true}, {Kind: Accept, Land: StageMerge}} {
		if _, err := Apply(ctx, db, task.ID, ev, "a99", "绕过"); err == nil {
			t.Fatalf("绕过成功：%+v", ev)
		}
	}
	if _, err := Decide(ctx, db, task.ID, "resume", "下级恢复", "a99"); err == nil {
		t.Fatal("越权恢复")
	}
	epoch, err := DeliveryEpoch(ctx, db, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(ctx, db, task.ID, Event{Kind: Accept, Epoch: epoch, Head: "old", Land: StageMerge}, "u1", ""); err != nil {
		t.Fatal(err)
	}
	if err := CheckApplication(ctx, db, task.ID, "old"); err != nil {
		t.Fatal(err)
	}
	if err := CheckApplication(ctx, db, task.ID, "new"); err == nil {
		t.Fatal("旧 head 授权绕过")
	}
	if _, err := Apply(ctx, db, task.ID, Event{Kind: Bounce}, "merge", ""); err != nil {
		t.Fatal(err)
	}
	if err := CheckApplication(ctx, db, task.ID, "old"); err == nil {
		t.Fatal("交回未使授权过期")
	}
	if _, err := Decide(ctx, db, task.ID, "resume", "明确恢复", "u1"); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(ctx, db, task.ID, Event{Kind: Set, To: Done}, "u1", ""); err != nil {
		t.Fatal(err)
	}
	t.Log("旧库迁移、重启、重派、退回、审阅、直接完成/应用绕过拒绝；明确恢复后推进：PASS")
}

func TestAcceptanceAuthority(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	root, err := org.Add(ctx, db, org.NewDept{Name: "上级"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := org.Add(ctx, db, org.NewDept{Name: "下级", Parent: root.ID})
	if err != nil {
		t.Fatal(err)
	}
	top, err := org.AddLeader(ctx, db, org.NewLeader{Name: "上级负责人", Workers: []string{"codex"}})
	if err != nil {
		t.Fatal(err)
	}
	low, err := org.AddLeader(ctx, db, org.NewLeader{Name: "下级负责人", Workers: []string{"codex"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := org.Edit(ctx, db, root.ID, org.DeptPatch{Leader: &top.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := org.Edit(ctx, db, child.ID, org.DeptPatch{Leader: &low.ID}); err != nil {
		t.Fatal(err)
	}
	task, err := Add(ctx, db, NewTask{Title: "验收", Org: child.ID}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Decide(ctx, db, task.ID, "hold", "上级暂缓", top.ID); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"hold", "resume"} {
		if _, err := Decide(ctx, db, task.ID, action, "越过", low.ID); err == nil {
			t.Fatal("下级越权", action)
		}
	}
	a, err := AcceptanceOf(ctx, db, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := MayDecide(ctx, db, a, low.ID); err == nil {
		t.Fatal("下级验收越权")
	}
	if _, err := Decide(ctx, db, task.ID, "resume", "原决策人解除", top.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := Decide(ctx, db, task.ID, "hold", "下级决定", low.ID); err != nil {
		t.Fatal(err)
	}
	a, _ = AcceptanceOf(ctx, db, task.ID)
	if err := MayDecide(ctx, db, a, top.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := Decide(ctx, db, task.ID, "resume", "上级解除", top.ID); err != nil {
		t.Fatal(err)
	}
	t.Log("下级不能覆盖、解除或验收；原决策人及上级可明确解除：PASS")
}
