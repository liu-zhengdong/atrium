package ledger_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestTransient(t *testing.T) {
	for _, s := range []string{
		"gh repo view：exit status 1：unexpected EOF", // t691 关卡现场
		"派 t1：git fetch：exit status 128：fatal: unable to access '…': RPC failed; curl 56 OpenSSL SSL_read: Connection was reset",             // t704 dispatch 现场
		"合入 t1：git push --quiet --force-with-lease=refs/heads/x:abc origin HEAD:refs/heads/x：exit status 1：! [rejected] x -> x (stale info)", // t882 合入队列现场
		"gh pr view：exit status 1：request failed: dial tcp: connection refused",
		"git fetch：fatal: Could not resolve host: github.com",
		"unexpected EOF", // 大小写不敏感
	} {
		if !ledger.Transient(errors.New(s)) {
			t.Errorf("Transient(%q) = false，要 true", s)
		}
	}
	for _, s := range []string{
		"--reason: 不能为空",
		"t1 要进合入队列，但还没有登记 PR",
		"exit status 128：fatal: not a git repository",
		"gh: Not Found",
		"没有机器能接：执行者都不在",
	} {
		if ledger.Transient(errors.New(s)) {
			t.Errorf("Transient(%q) = true，要 false", s)
		}
	}
}

// retryFixture 建一个任务并把重试间隔改短（跑完恢复），返回计数闭包供 run 用。
func retryFixture(t *testing.T) (context.Context, *store.DB, ledger.Task, func(fail func() error) func() error) {
	t.Helper()
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	task, err := ledger.Add(ctx, db, ledger.NewTask{Title: "retry"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	old := ledger.RetryDelays
	ledger.RetryDelays = []time.Duration{0, 0}
	t.Cleanup(func() { ledger.RetryDelays = old })
	round := func(fail func() error) func() error {
		return func() error {
			return ledger.EachTask(ctx, db, "test.op", []ledger.Task{task}, func(x ledger.Task) string { return x.ID },
				func(ledger.Task) error { return fail() })
		}
	}
	return ctx, db, task, round
}

func retries(t *testing.T, db *store.DB, task string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM task_events WHERE task=? AND kind=?`, task, ledger.KindLoopRetry).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestEachTaskTransientRetries(t *testing.T) {
	ctx, db, task, round := retryFixture(t)
	calls := 0
	run := round(func() error {
		calls++
		if calls <= 2 {
			return fmt.Errorf("gh repo view o/r：exit status 1：unexpected EOF")
		}
		return nil
	})
	for i := 0; i < 3; i++ {
		if err := run(); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 3 {
		t.Fatalf("临时失败应重试到成功，调用 %d 次", calls)
	}
	got, err := ledger.Get(ctx, db, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != ledger.Todo {
		t.Fatalf("重试期间状态不该变：%s", got.Status)
	}
	if n := retries(t, db, task.ID); n != 2 {
		t.Fatalf("应记 2 轮重试，记了 %d", n)
	}
}

func TestEachTaskTransientEscalates(t *testing.T) {
	ctx, db, task, round := retryFixture(t)
	calls := 0
	run := round(func() error {
		calls++
		return errors.New("git fetch：exit status 128：RPC failed")
	})
	if err := run(); err != nil {
		t.Fatal(err)
	}
	if err := run(); err != nil {
		t.Fatal(err)
	}
	if err := run(); err != nil {
		t.Fatal(err)
	}
	if calls != 3 { // 首次失败加两轮重试，第 3 次失败转受阻
		t.Fatalf("重试 %d 轮后应转受阻，调用 %d 次", len(ledger.RetryDelays), calls)
	}
	got, err := ledger.Get(ctx, db, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != ledger.Blocked {
		t.Fatalf("应转受阻，现在是 %s", got.Status)
	}
	if n := retries(t, db, task.ID); n != 2 {
		t.Fatalf("受阻前应记 2 轮重试，记了 %d", n)
	}
	var note string
	if err := db.QueryRow(`SELECT body FROM task_events WHERE task=? AND kind=?`, task.ID, ledger.KindLoopError).Scan(&note); err != nil {
		t.Fatal(err)
	}
	if want := "重试 2 轮仍失败"; !strings.Contains(note, want) {
		t.Fatalf("受阻原因要带重试轮数，现在：%s", note)
	}
}

func TestEachTaskNonTransientBlocks(t *testing.T) {
	ctx, db, task, round := retryFixture(t)
	calls := 0
	run := round(func() error {
		calls++
		return errors.New("t1 要进合入队列，但还没有登记 PR")
	})
	if err := run(); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("非临时错误不该重试，调用 %d 次", calls)
	}
	got, err := ledger.Get(ctx, db, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != ledger.Blocked {
		t.Fatalf("应直接转受阻，现在是 %s", got.Status)
	}
	if n := retries(t, db, task.ID); n != 0 {
		t.Fatalf("非临时错误不该记重试，记了 %d", n)
	}
}
