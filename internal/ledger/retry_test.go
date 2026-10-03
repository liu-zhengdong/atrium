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

// 重试间隔要真执行：到期前让出循环（不调用 run），到期后才重试；两轮用尽照常转受阻。
func TestEachTaskRetryWaits(t *testing.T) {
	ctx, db, task, _ := retryFixture(t)
	old := ledger.RetryDelays
	ledger.RetryDelays = []time.Duration{time.Hour, 0}
	t.Cleanup(func() { ledger.RetryDelays = old })
	calls := 0
	round := func() {
		t.Helper()
		err := ledger.EachTask(ctx, db, "test.op", []ledger.Task{task}, func(x ledger.Task) string { return x.ID },
			func(ledger.Task) error { calls++; return fmt.Errorf("gh repo view：unexpected EOF") })
		if err != nil {
			t.Fatal(err)
		}
	}
	round() // 第 1 次失败，记第 1 轮重试（1 小时后）
	if calls != 1 {
		t.Fatalf("第 1 次该跑，调了 %d 次", calls)
	}
	if hold, err := ledger.RetryHold(ctx, db, task.ID, "test.op"); err != nil || !hold {
		t.Fatalf("间隔没到期应让出：hold=%v err=%v", hold, err)
	}
	round() // 间隔没到期：让出，不重试
	if calls != 1 {
		t.Fatalf("间隔没到期不该重试，调了 %d 次", calls)
	}
	// 把重试记录拨到 1 小时前，模拟间隔到期（测试不真等）。
	if _, err := db.Exec(`UPDATE task_events SET at = at - ? WHERE task = ? AND kind = ?`,
		int64(time.Hour/time.Millisecond), task.ID, ledger.KindLoopRetry); err != nil {
		t.Fatal(err)
	}
	if hold, err := ledger.RetryHold(ctx, db, task.ID, "test.op"); err != nil || hold {
		t.Fatalf("间隔到期不该让出：hold=%v err=%v", hold, err)
	}
	round() // 到期：第 2 次失败，记第 2 轮（间隔 0）
	if calls != 2 {
		t.Fatalf("到期后该重试，调了 %d 次", calls)
	}
	round() // 第 3 次失败：两轮用尽转受阻
	if calls != 3 {
		t.Fatalf("两轮用尽该转受阻，调了 %d 次", calls)
	}
	got, err := ledger.Get(ctx, db, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != ledger.Blocked {
		t.Fatalf("应转受阻，现在是 %s", got.Status)
	}
}

// 连续失败按「最近一次推进之后、按操作」计：别的操作的失败不占预算；重试后
// 成功重置；受阻后重派（enqueue）拿到完整预算。
func TestEachTaskRetryCountsConsecutive(t *testing.T) {
	round := func(t *testing.T, ctx context.Context, db *store.DB, task ledger.Task, op string, fail bool) {
		t.Helper()
		var err error
		e := ledger.EachTask(ctx, db, op, []ledger.Task{task}, func(x ledger.Task) string { return x.ID },
			func(ledger.Task) error {
				if fail {
					err = fmt.Errorf("git fetch：RPC failed")
				}
				return err
			})
		if e != nil {
			t.Fatal(e)
		}
	}
	fail := true
	status := func(t *testing.T, ctx context.Context, db *store.DB, id string) ledger.Status {
		t.Helper()
		got, err := ledger.Get(ctx, db, id)
		if err != nil {
			t.Fatal(err)
		}
		return got.Status
	}

	t.Run("跨操作不占预算", func(t *testing.T) {
		ctx, db, task, _ := retryFixture(t) // RetryDelays {0,0}：同一操作第 3 次失败转受阻
		round(t, ctx, db, task, "a.op", fail)
		round(t, ctx, db, task, "a.op", fail)
		round(t, ctx, db, task, "b.op", fail) // b 的第一轮：a 的两轮不算
		if s := status(t, ctx, db, task.ID); s == ledger.Blocked {
			t.Fatal("别的操作的失败不该耗掉本操作预算")
		}
		round(t, ctx, db, task, "b.op", fail)
		round(t, ctx, db, task, "b.op", fail)
		if s := status(t, ctx, db, task.ID); s != ledger.Blocked {
			t.Fatalf("b.op 三连败该转受阻，现在是 %s", s)
		}
	})

	t.Run("成功后重置", func(t *testing.T) {
		ctx, db, task, _ := retryFixture(t)
		ok := false
		mixed := func(fail bool) {
			t.Helper()
			e := ledger.EachTask(ctx, db, "c.op", []ledger.Task{task}, func(x ledger.Task) string { return x.ID },
				func(ledger.Task) error {
					if fail {
						return fmt.Errorf("git fetch：RPC failed")
					}
					ok = true
					return nil
				})
			if e != nil {
				t.Fatal(e)
			}
		}
		mixed(true)  // #1
		mixed(false) // 成功：重置
		if !ok {
			t.Fatal("成功路径没跑到")
		}
		mixed(true) // 又是 #1；若按累计计，这一轮就该转受阻
		mixed(true) // #2
		if s := status(t, ctx, db, task.ID); s == ledger.Blocked {
			t.Fatal("成功后失败轮次该重置")
		}
		mixed(true) // 第 3 连败才转受阻
		if s := status(t, ctx, db, task.ID); s != ledger.Blocked {
			t.Fatalf("第 3 连败该转受阻，现在是 %s", s)
		}
	})

	t.Run("受阻后重派拿满预算", func(t *testing.T) {
		ctx, db, task, _ := retryFixture(t)
		round(t, ctx, db, task, "d.op", fail)
		round(t, ctx, db, task, "d.op", fail)
		round(t, ctx, db, task, "d.op", fail)
		if s := status(t, ctx, db, task.ID); s != ledger.Blocked {
			t.Fatalf("该转受阻，现在是 %s", s)
		}
		if _, err := ledger.Apply(ctx, db, task.ID, ledger.Event{Kind: ledger.Enqueue}, "u1", "重派"); err != nil {
			t.Fatal(err)
		}
		round(t, ctx, db, task, "d.op", fail) // 重派后第一轮：旧的两轮不算
		if s := status(t, ctx, db, task.ID); s == ledger.Blocked {
			t.Fatal("重派后第一次瞬断该记重试而不是又转受阻")
		}
		if n := retries(t, db, task.ID); n != 3 {
			t.Fatalf("应记 3 轮重试（2 旧 1 新），记了 %d", n)
		}
	})
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
