package dispatch

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
)

// flakyExec 每次调用都按网络抖动失败（cmd、stderr 照 git 的真实输出）。
type flakyExec struct{ msg string }

func (f flakyExec) Run(context.Context, string, string, ...string) (string, error) {
	return "", &gates.CmdError{Cmd: "git ls-remote origin", Stderr: f.msg, Err: errors.New("exit status 128")}
}

// dispatch 拉起时的外部 git 调用瞬断（t704 的 RPC failed）不该转受阻：记一
// 轮重试、任务留在队列，下一轮 pump 重派成功；连续失败才转受阻（ledger 测）。
func TestLaunchTransientRetries(t *testing.T) {
	delays := ledger.RetryDelays
	ledger.RetryDelays = []time.Duration{0, 0, 0} // 间隔到期检查在 ledger 测，这里只管触发重试
	t.Cleanup(func() { ledger.RetryDelays = delays })
	env, d := setup(t)
	ctx := context.Background()
	repo := gitRepo(t)
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "改 README", Repo: repo}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: fakeOK}, "u1"); err != nil {
		t.Fatal(err)
	}
	old := originRunner
	calls := 0
	originRunner = func() gates.Runner {
		calls++
		if calls > 1 {
			return old()
		}
		return flakyExec{"fatal: unable to access '" + repo + "': RPC failed; curl 56 OpenSSL SSL_read: Connection was reset"}
	}
	t.Cleanup(func() { originRunner = old })
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := ledger.Get(ctx, env.DB, tk.ID); got.Status != ledger.Queued {
		t.Fatalf("临时失败应留在队列等重试：%s/%s", got.Status, got.Stage)
	}
	var n int
	if err := env.DB.QueryRowContext(ctx,
		`SELECT count(*) FROM task_events WHERE task = ? AND kind = ?`, tk.ID, ledger.KindLoopRetry).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("应记 1 轮重试，记了 %d", n)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	got := waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
	if got.Status != ledger.Running {
		t.Fatalf("下一轮应重派成功：%+v", got)
	}
}
