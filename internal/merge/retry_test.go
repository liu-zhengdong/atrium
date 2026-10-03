package merge_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/gates/fakegh"
	"github.com/liu-zhengdong/atrium/internal/ledger"
)

// racePush 在第一次 git push 前模拟执行者中途强推改写远端分支，然后放行原
// push：真 git 会用 --force-with-lease 拒掉它，正是 t882 的 stale info。
type racePush struct {
	gates.Runner
	gh   *fakegh.GH
	once bool
}

func (r *racePush) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	if !r.once && name == "git" && len(args) > 0 && args[0] == "push" {
		r.once = true
		g := r.gh
		g.Must(g.Work, "fetch", "--quiet", "origin")
		g.Must(g.Work, "checkout", "--quiet", "-B", "t1-a", "origin/t1-a")
		g.Write(g.Work, "late.go", "package late\n")
		g.Must(g.Work, "add", "-A")
		g.Must(g.Work, "commit", "--quiet", "--amend", "-m", "mid-air")
		g.Must(g.Work, "push", "--quiet", "--force", "origin", "t1-a")
	}
	return r.Runner.Run(ctx, dir, name, args...)
}

// 队列取 PR 头后执行者中途强推，push --force-with-lease 被拒（stale info）。
// 队列每轮 next 都重新取头，重跑一轮即可自愈：记一轮重试、不转受阻。
func TestMergeStaleInfoRetries(t *testing.T) {
	old := ledger.RetryDelays
	ledger.RetryDelays = []time.Duration{0, 0, 0} // 间隔到期检查在 ledger 测，这里只管触发重试
	t.Cleanup(func() { ledger.RetryDelays = old })
	e := setup(t, nil)
	task := e.deliver("t1-a", map[string]string{"a.go": "package a\n"})
	e.gh.Commit(map[string]string{"other.go": "package o\n"}) // main 先前进：合入要 rebase 后强推分支，才会走到那条 push
	e.q.R = &racePush{Runner: e.gh, gh: e.gh}
	e.drain()
	if got := e.get(task.ID); got.Status != ledger.Done || got.Stage != ledger.StageMerged {
		t.Fatalf("重跑一轮应自愈合入：%+v %s", got, e.lastNote(task.ID))
	}
	var n int
	if err := e.db.QueryRowContext(e.ctx,
		`SELECT count(*) FROM task_events WHERE task = ? AND kind = ?`, task.ID, ledger.KindLoopRetry).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("应记 1 轮重试，记了 %d", n)
	}
	var note string
	if err := e.db.QueryRowContext(e.ctx,
		`SELECT body FROM task_events WHERE task = ? AND kind = ?`, task.ID, ledger.KindLoopRetry).Scan(&note); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(note, "stale info") {
		t.Fatalf("重试记录要带失败原因：%s", note)
	}
}
