package gates_test

import (
	"path/filepath"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
)

func TestSweepBadWorkspaceContinues(t *testing.T) {
	e := setup(t)
	bad := e.delivered("旧登记缺机器", "dsh+opus", "")
	if err := ledger.Record(e.ctx, e.db, bad.ID, gates.KindWorktree, "dispatch", `{"dir":"unused"}`); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "wt")
	e.gh.Branch(dir, "t2-work", map[string]string{"a.go": "package a\n"})
	e.gh.Open("t2-work", goodBody)
	good := e.delivered("正常交付", "dsh+opus", dir)
	e.sweep()
	e.sweep()
	if got := e.get(bad.ID); got.Status != ledger.Blocked {
		t.Fatalf("bad: %+v", got)
	}
	if got := e.get(good.ID); got.Stage != ledger.StageMerge {
		t.Fatalf("good: %+v", got)
	}
	if got := e.count(bad.ID, ledger.KindLoopError); got != 1 {
		t.Fatalf("重复错误经历=%d", got)
	}
	t.Log("缺机器的工作树任务受阻，正常交付进入合入队列，第二轮无重复错误")
}
