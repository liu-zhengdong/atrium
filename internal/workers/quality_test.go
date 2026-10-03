package workers

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org/leaders"
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
	got := Qualities(ls, nil)
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
		for _, q := range Qualities(copy, nil) {
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
	if g := Qualities([]Attempt{b, a}, nil); g[0].Combo != "pi+a" {
		t.Fatal(g)
	}
	// 负责人唤醒与任务拉起同组合也分开成行、排在后面，任务行数字不变。
	wakes := []Attempt{{Worker: "codex+m:high", N: 1, Outcome: OutOK, DurationMS: &d1}, {Worker: "codex+m", N: 2, Outcome: OutFail, Reason: "没确认 1/1 件"}, {Worker: "pi+m", N: 1, Outcome: OutSetup}}
	mixed := Qualities(ls, wakes)
	if !reflect.DeepEqual(mixed[:3], got) || len(mixed) != 5 {
		t.Fatalf("任务行应不变：%+v", mixed)
	}
	lc, lp := mixed[3], mixed[4]
	if !lc.Leader || lc.Name() != "codex+m（负责人）" || lc.Launches != 2 || lc.OK != 1 || lc.Fail != 1 || lc.Retries != 1 || lp.Name() != "pi+m（负责人）" || lp.Setup != 1 || got[0].Name() != "pi+m" {
		t.Fatalf("负责人行：%+v %+v", lc, lp)
	}
}

func TestWakeOutcomesMatch(t *testing.T) {
	if leaders.WakeOK != OutOK || leaders.WakeFail != OutFail || leaders.WakeSetup != OutSetup {
		t.Fatal("唤醒结果的取值必须与拉起结果一致")
	}
}

// 负责人日志段（开头带唤醒标记行）按档案取实际模型与用量，与任务拉起同一套解析。
func TestLeaderUsage(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	raw, err := os.ReadFile("testdata/pi-bash.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	seg := "\n=== 2026-10-03T10:00:00+08:00 唤醒 a9（pi+opencode-go/glm-5.3-flash:high），事件 [1]\n" + string(raw)
	model, u, err := LeaderUsage(context.Background(), db, "pi+opencode-go/glm-5.3-flash:high", seg)
	if err != nil {
		t.Fatal(err)
	}
	if model != "opencode-go/glm-5.3-flash" || u.Tokens.Input == nil || *u.Tokens.Input != 51026 || u.Cost == nil {
		t.Fatalf("模型 %q 用量 %+v", model, u)
	}
	if _, _, err := LeaderUsage(context.Background(), db, "没这个工具+m", seg); err == nil {
		t.Fatal("解析不了的组合要报错")
	}
}

func TestReadQualityLeaderWakes(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "quality.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ins := func(outcome, usage string) {
		t.Helper()
		if _, err := db.ExecContext(ctx, `INSERT INTO leader_wakes (leader, profile, n, outcome, usage, duration_ms, at) VALUES ('a9', 'pi+opencode-go/glm-5.3-flash:high', 1, ?, ?, 1000, 1)`, outcome, usage); err != nil {
			t.Fatal(err)
		}
	}
	ins(OutOK, `{"cost":0.5,"currency":"USD"}`)
	ins(OutFail, `{"cost":0.5,"currency":"USD"}`)
	got, err := ReadQuality(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !got[0].Leader || got[0].Combo != "pi+opencode-go/glm-5.3-flash" || got[0].Launches != 2 || got[0].OK != 1 || got[0].CostPerDeliveryUSD == nil || *got[0].CostPerDeliveryUSD != 1 {
		t.Fatalf("负责人行：%+v", got)
	}
	ins(OutOK, "{")
	if _, err := ReadQuality(ctx, db); err == nil {
		t.Fatal("损坏的唤醒记录必须报错")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO leader_wakes (leader, profile, n, outcome, at) VALUES ('a9', 'x', 1, 'bounce', 1)`); err == nil {
		t.Fatal("唤醒没有被交回这一结果")
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
