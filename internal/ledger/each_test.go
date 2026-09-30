package ledger_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 与未来回收循环相同：整个按件动作交 EachTask，包括工作树登记解析。
func TestEachTaskBadWorkspace(t *testing.T) {
	for _, status := range []ledger.Status{ledger.Todo, ledger.Draft, ledger.Done, ledger.Failed, ledger.Cancelled, ledger.Blocked} {
		for _, body := range []string{`{"dir":"unused"}`, `{"host":"h1"}`, `{broken`} {
			t.Run(string(status)+body, func(t *testing.T) {
				ctx := context.Background()
				path := filepath.Join(t.TempDir(), "db")
				db, err := store.Open(path)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { db.Close() }()
				dept, err := org.Add(ctx, db, org.NewDept{Name: "测试部门"})
				if err != nil {
					t.Fatal(err)
				}
				bad, err := ledger.Add(ctx, db, ledger.NewTask{Title: "bad", Org: dept.ID}, "u1")
				if err != nil {
					t.Fatal(err)
				}
				if status != ledger.Todo {
					bad, err = ledger.Apply(ctx, db, bad.ID, ledger.Event{Kind: ledger.Set, To: status}, "runtime", "test")
					if err != nil {
						t.Fatal(err)
					}
				}
				good, err := ledger.Add(ctx, db, ledger.NewTask{Title: "good"}, "u1")
				if err != nil {
					t.Fatal(err)
				}
				if err := ledger.Record(ctx, db, bad.ID, gates.KindWorktree, "runtime", body); err != nil {
					t.Fatal(err)
				}
				calls, goodCalls := 0, 0
				round := func() error {
					return ledger.EachTask(ctx, db, "cleanup", []ledger.Task{bad, good}, func(x ledger.Task) string { return x.ID }, func(x ledger.Task) error {
						if x.ID == good.ID {
							goodCalls++
							return nil
						}
						calls++
						_, _, err := gates.Workspace(ctx, db, x.ID)
						return err
					})
				}
				if err := round(); err != nil {
					t.Fatal(err)
				}
				got, err := ledger.Get(ctx, db, bad.ID)
				if err != nil {
					t.Fatal(err)
				}
				want := status
				if !status.Finished() {
					want = ledger.Blocked
				}
				if got.Status != want {
					t.Fatalf("bad status=%s want %s", got.Status, want)
				}
				if err := db.Close(); err != nil {
					t.Fatal(err)
				}
				db, err = store.Open(path)
				if err != nil {
					t.Fatal(err)
				} // 重启后仍不重试
				if err := round(); err != nil {
					t.Fatal(err)
				}
				if calls != 1 || goodCalls != 2 {
					t.Fatalf("calls bad=%d good=%d", calls, goodCalls)
				}
				var n int
				if err := db.QueryRow(`SELECT count(*) FROM task_events WHERE task=? AND kind=?`, bad.ID, ledger.KindLoopError).Scan(&n); err != nil {
					t.Fatal(err)
				}
				if n != 1 {
					t.Fatalf("error records=%d", n)
				}
				var note string
				if err := db.QueryRow(`SELECT body FROM task_events WHERE task=? AND kind=?`, bad.ID, ledger.KindLoopError).Scan(&note); err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(note, "工作树登记") {
					t.Fatalf("missing reason: %s", note)
				}
				if status != ledger.Blocked && !status.Finished() {
					if err := db.QueryRow(`SELECT count(*) FROM events WHERE task=? AND kind='task.status' AND body LIKE '%blocked%'`, bad.ID).Scan(&n); err != nil {
						t.Fatal(err)
					}
					if n == 0 {
						t.Fatal("没有受阻通知")
					}
				}
				if _, err := ledger.Apply(ctx, db, bad.ID, ledger.Event{Kind: ledger.Set, To: ledger.Todo}, "u1", "重试"); err != nil {
					t.Fatal(err)
				}
				if err := round(); err != nil {
					t.Fatal(err)
				}
				if calls != 2 {
					t.Fatal("人工重试未解除失败标记")
				}
			})
		}
	}
}

func TestEachTaskInfrastructure(t *testing.T) {
	for _, kind := range []string{"closed", "sql", "cancel", "global", "timeout"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			db := loopDB(t)
			task, err := ledger.Add(ctx, db, ledger.NewTask{Title: "test"}, "u1")
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			err = ledger.EachTask(ctx, db, "test", []ledger.Task{task, task}, func(t ledger.Task) string { return t.ID }, func(ledger.Task) error {
				calls++
				switch kind {
				case "closed":
					db.Close()
					return errors.New("operation failed")
				case "sql":
					_, err := db.Exec(`SELECT * FROM missing_table`)
					return fmt.Errorf("wrapped: %w", err)
				case "cancel":
					cancel()
					return ctx.Err()
				case "global":
					return app.Global(errors.New("shared data broken"))
				default:
					return context.DeadlineExceeded
				}
			})
			if kind == "timeout" {
				if err != nil {
					t.Fatal(err)
				}
				got, _ := ledger.Get(context.Background(), db, task.ID)
				if got.Status != ledger.Blocked {
					t.Fatal("子操作超时没有隔离")
				}
			} else if err == nil {
				t.Fatal("基础设施故障被吞掉")
			}
			if calls != 1 {
				t.Fatalf("calls=%d", calls)
			}
		})
	}
}

func TestEachTaskBadOwnerRecord(t *testing.T) {
	db := loopDB(t)
	ctx := context.Background()
	task, err := ledger.Add(ctx, db, ledger.NewTask{Title: "bad owner"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE task_events SET body='{broken' WHERE task=? AND kind='created'`, task.ID); err != nil {
		t.Fatal(err)
	}
	if err := ledger.EachTask(ctx, db, "test", []ledger.Task{task}, func(t ledger.Task) string { return t.ID }, func(ledger.Task) error { return errors.New("bad task") }); err != nil {
		t.Fatal(err)
	}
	got, err := ledger.Get(ctx, db, task.ID)
	if err != nil || got.Status != ledger.Blocked {
		t.Fatalf("got=%+v err=%v", got, err)
	}
}

func loopDB(t *testing.T) *store.DB {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}
