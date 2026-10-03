package workers

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestQualities(t *testing.T) {
	raw, err := os.ReadFile("testdata/quality.json")
	if err != nil {
		t.Fatal(err)
	}
	var ls []Attempt
	if err := json.Unmarshal(raw, &ls); err != nil {
		t.Fatal(err)
	}
	got := Qualities(ls)
	if len(got) != 3 || got[0].Combo != "pi+m" || got[1].Combo != "claude+m" {
		t.Fatalf("质量排序：%+v", got)
	}
	q := got[2]
	if q.Launches != 5 || q.OK != 1 || q.Bounce != 1 || q.Fail != 1 || q.Quota != 1 || q.Setup != 1 || q.DeliveryRate != 0.2 || q.Retries != 4 || q.RetryRate != 0.8 || q.BounceReasons["检查未通过"] != 1 || q.CostPerDeliveryUSD == nil || *q.CostPerDeliveryUSD != 10 || q.MedianMS == nil || *q.MedianMS != 20000 {
		t.Fatalf("统计：%+v", q)
	}
	if !reflect.DeepEqual(q.Stat, Count(Recent(ls, StatWindow)[q.Combo])) {
		t.Fatal("窗口内与 Count 不一致")
	}
	for _, mutation := range []Usage{{}, {Cost: ls[0].Usage.Cost, Currency: "CNY"}, {Cost: ls[0].Usage.Cost, Currency: "USD", Missing: []string{"输入"}}} {
		copy := append([]Attempt(nil), ls...)
		copy[0].Usage = mutation
		for _, q := range Qualities(copy) {
			if q.Combo == "codex+m" && q.CostPerDeliveryUSD != nil {
				t.Fatalf("不完整花费不能排序为免费：%+v", q)
			}
		}
	}
	// 同率同花费时用时短在前，未知在后；最终名字保证确定顺序。
	d1, d2 := int64(1000), int64(2000)
	a := Attempt{Worker: "pi+a", Outcome: OutOK, Usage: ls[7].Usage, DurationMS: &d1}
	b := a
	b.Worker = "pi+b"
	b.DurationMS = &d2
	if g := Qualities([]Attempt{b, a}); g[0].Combo != "pi+a" {
		t.Fatal(g)
	}
}

func TestReadQualityAllHistory(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "quality.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	task, err := ledger.Add(ctx, db, ledger.NewTask{Title: "分页质量统计"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	// 超过旧 statScan，交回恰好跨页；不能丢老拉起或把交回算交付。
	for i := 1; i <= 10001; i++ {
		for _, e := range []struct{ kind, body string }{{RunKind, fmtRun(i)}, {ExitKind, `{"outcome":"ok"}`}} {
			if _, err := db.ExecContext(ctx, `INSERT INTO task_events(task,kind,body,at,actor) VALUES(?,?,?,?,?)`, task.ID, e.kind, e.body, i*1000, "runtime"); err != nil {
				t.Fatal(err)
			}
		}
		if i == 500 {
			if err := ledger.Record(ctx, db, task.ID, "bounce", "runtime", `{"note":"跨页交回"}`); err != nil {
				t.Fatal(err)
			}
		}
	}
	got, err := ReadQuality(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Launches != 10001 || got[0].OK != 10000 || got[0].BounceReasons["跨页交回"] != 1 {
		t.Fatalf("全量：%+v", got)
	}
	if _, err := db.ExecContext(ctx, `UPDATE task_events SET body = ? WHERE task = ? AND kind = ?`, "{", task.ID, ExitKind); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadQuality(ctx, db); err == nil {
		t.Fatal("损坏经历必须报错")
	}
}

func fmtRun(n int) string {
	raw, _ := json.Marshal(Run{N: n, Worker: "codex+m:high", Host: "h0"})
	return string(raw)
}
