package gates_test

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/gates/fakegh"
	"github.com/liu-zhengdong/atrium/internal/ledger"
)

// 关卡调 gh 瞬断（t691 的 unexpected EOF）不该转受阻：记一轮重试，任务留在
// 原阶段，下一轮 Sweep 网络好了照常过；连续失败才转受阻（ledger 测）。
func TestGateTransientRetries(t *testing.T) {
	delays := ledger.RetryDelays
	ledger.RetryDelays = []time.Duration{0, 0, 0} // 间隔到期检查在 ledger 测，这里只管触发重试
	t.Cleanup(func() { ledger.RetryDelays = delays })
	e := setup(t)
	dir := filepath.Join(t.TempDir(), "wt")
	e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
	e.gh.Open("t1-work", goodBody)
	task := e.delivered("做事", "claude+opus", dir)
	old := e.g.R
	e.g.R = fakegh.Flaky(e.gh, 1, "gh repo", "unexpected EOF")
	e.sweep()
	if got := e.get(task.ID); got.Status != ledger.Running || got.Stage != ledger.StageGate {
		t.Fatalf("临时失败应留在关卡等重试：%+v", got)
	}
	if n := e.count(task.ID, ledger.KindLoopRetry); n != 1 {
		t.Fatalf("应记 1 轮重试，记了 %d", n)
	}
	if note := e.lastNote(task.ID); !strings.Contains(note, "unexpected EOF") {
		t.Fatalf("重试记录要带失败原因：%s", note)
	}
	e.g.R = old
	e.sweep()
	if got := e.get(task.ID); got.Status != ledger.Running || got.Stage != ledger.StageMerge {
		t.Fatalf("下一轮应照常过关卡：%+v", got)
	}
	if n := e.count(task.ID, ledger.KindLoopError); n != 0 {
		t.Fatalf("不该记失败：%d", n)
	}
}
