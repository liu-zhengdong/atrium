package workers

import (
	"context"
	"fmt"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
	"math"
	"path/filepath"
	"testing"
)

func TestTaskConsumption(t *testing.T) {
	completed := map[string]bool{}
	var ls []Attempt
	add := func(task string, n int, cost *float64, currency string) {
		completed[task] = true
		ls = append(ls, Attempt{Task: task, N: n, Worker: "pi+m", Outcome: OutOK, Usage: Usage{Cost: cost, Currency: currency, Tokens: Tokens{Output: token(10)}}})
	}
	// 五件完整任务，包括一次重试：按任务总和 [0,2,4,6,1000]，不能按拉起取分位。
	for i, v := range []float64{0, 2, 4, 6, 1000} {
		add(fmt.Sprint(i), 1, price(v), "USD")
	}
	ls[3].Usage.Cost = price(3)
	add("3", 2, price(3), "USD")
	for _, v := range []*float64{nil, price(-1), price(math.NaN()), price(math.Inf(1))} {
		add(fmt.Sprint(len(ls)), 1, v, "USD")
	}
	add("foreign", 1, price(99), "CNY")
	add("partial", 1, price(0), "USD")
	ls[len(ls)-1].Usage.Missing = []string{"输入"}
	add("absent-first", 2, price(1), "USD")
	add("duplicate", 1, price(1), "USD")
	add("duplicate", 1, price(1), "USD")
	add("mixed", 1, price(1), "USD")
	add("mixed", 2, price(1), "USD")
	ls[len(ls)-1].Worker = "pi+other"
	add("active", 1, price(999), "USD")
	completed["active"] = false
	got := taskConsumptions(ls, completed, Combo)["pi+m"]
	m := got.Metrics[0]
	if got.Tasks != 13 || got.Mixed != 1 || m.Samples != 5 || m.Median == nil || *m.Median != 4 || *m.P75 != 6 {
		t.Fatalf("任务覆盖/分位错误：%+v %+v", got, m)
	}
	// 负 token 拒绝；货币必须用退出时折合，缺折合不能当同名 USD。
	u := Usage{Cost: price(7), Currency: "CNY", USD: price(1)}
	if *taskMetricValue(u, 0) != 1 {
		t.Fatal("没有使用历史折合")
	}
	// 少样本仍可显示覆盖，分位必须为空，零是有效读数。
	few := taskConsumptions(ls[:4], completed, Combo)["pi+m"].Metrics[0]
	if few.Samples != 4 || few.Median != nil || few.P75 != nil {
		t.Fatalf("少样本编了估计：%+v", few)
	}
}

func TestTaskConsumptionMetricCoverage(t *testing.T) {
	var ls []Attempt
	done := map[string]bool{}
	for i := 0; i < 5; i++ {
		id := fmt.Sprint(i)
		done[id] = true
		ls = append(ls, Attempt{Task: id, N: 1, Worker: "pi+m", Outcome: OutOK, Usage: Usage{Cost: price(0), Currency: "USD", Source: "estimate", Tokens: Tokens{Input: token(0), Output: token(-1)}}})
	}
	c := taskConsumptions(ls, done, Combo)["pi+m"]
	if *c.Metrics[0].Median != 0 || c.Metrics[0].Estimated != 5 || *c.Metrics[1].Median != 0 || c.Metrics[2].Samples != 0 || c.Metrics[3].Samples != 0 {
		t.Fatalf("零、异常与缺失混了：%+v", c)
	}
	if v := taskQuantile([]float64{0, 2, 4, 6, 8, 10}, 0.75); v != 7.5 {
		t.Fatal(v)
	}
}

func TestTaskConsumptionWindow(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "tasks.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	since := store.Now() - QualityWindow.Milliseconds()
	var attempts []Attempt
	for _, kind := range []string{"done", "old", "todo", "failed", "cancelled"} {
		task, err := ledger.Add(ctx, db, ledger.NewTask{Title: kind}, "u1")
		if err != nil {
			t.Fatal(err)
		}
		if kind != "todo" {
			status := ledger.Done
			if kind == "failed" {
				status = ledger.Failed
			}
			if kind == "cancelled" {
				status = ledger.Cancelled
			}
			_, err = ledger.Apply(ctx, db, task.ID, ledger.Event{Kind: ledger.Set, To: status}, "u1", "")
			if err != nil {
				t.Fatal(err)
			}
		}
		if kind == "old" {
			_, err = db.ExecContext(ctx, `UPDATE tasks SET created_at = ? WHERE id = ?`, since-1, task.ID)
			if err != nil {
				t.Fatal(err)
			}
		}
		attempts = append(attempts, Attempt{Task: task.ID, N: 1, Worker: "pi+m", Outcome: OutOK, Usage: Usage{Cost: price(0), Currency: "USD"}})
	}
	got, err := ReadTaskConsumptions(ctx, db, attempts, since, Combo)
	if err != nil {
		t.Fatal(err)
	}
	if got["pi+m"].Tasks != 1 || got["pi+m"].Metrics[0].Samples != 1 {
		t.Fatalf("窗口/完成状态错误：%+v", got)
	}
}
