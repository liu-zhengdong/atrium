package dispatch

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/watch"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func TestRecoveryWatchBoundAndStop(t *testing.T) {
	for _, scenario := range []string{"first", "bounded", "stopped"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			dir := t.TempDir()
			db, err := store.Open(filepath.Join(dir, "a.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			env := &app.Env{DB: db, Paths: config.Paths{Data: dir}}
			tk, err := ledger.Add(ctx, db, ledger.NewTask{Title: scenario}, "u1")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Enqueue(ctx, env, tk.ID, Options{}, "u1"); err != nil {
				t.Fatal(err)
			}
			if _, err := ledger.Apply(ctx, db, tk.ID, ledger.Event{Kind: ledger.Start}, actor, ""); err != nil {
				t.Fatal(err)
			}
			worker := "dsh"
			count := 1
			if scenario == "bounded" {
				count = 3
			}
			log := filepath.Join(dir, "run.log")
			if err := os.WriteFile(log, []byte("ERROR: usage limit reached\n"), 0600); err != nil {
				t.Fatal(err)
			}
			for n := 1; n <= count; n++ {
				why := workers.WhyFirst
				if n > 1 {
					why = workers.WhySwitch
				}
				raw, _ := json.Marshal(workers.Run{N: n, Why: why, Worker: worker, Host: LocalHost, Risk: "low", Log: log, At: store.Now()})
				if err := ledger.Record(ctx, db, tk.ID, workers.RunKind, actor, string(raw)); err != nil {
					t.Fatal(err)
				}
			}
			ending := ledger.ExitFail
			if scenario == "stopped" {
				ending = ledger.Block
			}
			if _, err := ledger.Apply(ctx, db, tk.ID, ledger.Event{Kind: ending}, actor, ""); err != nil {
				t.Fatal(err)
			}
			if err := Requeue(ctx, env, tk.ID, watch.Why{Signal: watch.SigQuota, Worker: worker, Reason: "额度用尽"}); err != nil {
				t.Fatal(err)
			}
			got, err := ledger.Get(ctx, db, tk.ID)
			if err != nil {
				t.Fatal(err)
			}
			marks, err := workers.Marks(ctx, db, store.Now())
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "first" {
				items, err := queued(ctx, db)
				if err != nil {
					t.Fatal(err)
				}
				// 额度用尽的组合由标记管退避，不进 Avoid（否则标记到期时它已被排除，只剩转受阻）。
				if got.Status != ledger.Queued || len(items) != 1 || !items[0].Opts.Switch || len(items[0].Opts.Avoid) != 0 {
					t.Fatalf("首次巡检恢复应保留这轮计数：%+v %+v", got, items)
				}
			} else if got.Status != ledger.Blocked {
				t.Fatalf("不能绕开上限或复活被停任务：%+v", got)
			}
			if scenario == "stopped" && len(marks) != 0 {
				t.Fatalf("被停不能归为额度失败：%+v", marks)
			}
			if scenario != "stopped" && (len(marks) != 1 || marks[0].Until <= store.Now()) {
				t.Fatalf("原标记应继续保留：%+v", marks)
			}
		})
	}
}
