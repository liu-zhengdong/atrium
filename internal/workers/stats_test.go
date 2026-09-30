package workers

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestOutcomeOf(t *testing.T) {
	cases := []struct {
		sig   string
		ended bool
		want  string
	}{
		{SignalQuota, false, OutQuota},
		{SignalSetup, false, OutSetup},
		{SignalNoStart, false, OutSetup},
		{SignalModel, false, OutFail},
		{SignalTransient, true, OutFail},
		{SignalThinking, true, OutFail},
		{SignalNone, false, OutFail},
		{SignalNone, true, OutOK},
	}
	for _, c := range cases {
		if got := OutcomeOf(Signal{Kind: c.sig}, c.ended); got != c.want {
			t.Errorf("%q ended=%v → %s，应为 %s", c.sig, c.ended, got, c.want)
		}
	}
}

// 同一任务先 agy 撞额度、再 claude 完成：两边各记各的；另有被交回、watch 直接收尾、还在跑的。
func TestStats(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	at := int64(1000)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	apply := func(id string, ev ledger.Event) {
		t.Helper()
		_, err := ledger.Apply(ctx, db, id, ev, "runtime", string(ev.Kind))
		must(err)
	}
	launch := func(id string, n int, worker string) {
		t.Helper()
		apply(id, ledger.Event{Kind: ledger.Start})
		at++
		raw, _ := json.Marshal(Run{N: n, Worker: worker, Host: "h0", At: at})
		must(ledger.Record(ctx, db, id, RunKind, "runtime", string(raw)))
	}
	exit := func(id string, n int, out string) {
		t.Helper()
		raw, _ := json.Marshal(Exit{N: n, Outcome: out, Reason: "原因 " + out})
		must(ledger.Record(ctx, db, id, ExitKind, "runtime", string(raw)))
	}
	add := func(title string) string {
		t.Helper()
		tk, err := ledger.Add(ctx, db, ledger.NewTask{Title: title}, "u1")
		must(err)
		apply(tk.ID, ledger.Event{Kind: ledger.Enqueue})
		return tk.ID
	}

	t1 := add("agy 撞额度后改派 claude")
	launch(t1, 1, "agy+gemini-3.8-flash-high")
	exit(t1, 1, OutQuota)
	apply(t1, ledger.Event{Kind: ledger.ExitFail})
	apply(t1, ledger.Event{Kind: ledger.Enqueue})
	launch(t1, 2, "claude+opus:high")
	exit(t1, 2, OutOK)
	apply(t1, ledger.Event{Kind: ledger.ExitOK})
	apply(t1, ledger.Event{Kind: ledger.GatePass})

	t2 := add("被关卡交回一次")
	launch(t2, 1, "claude+opus")
	exit(t2, 1, OutOK)
	apply(t2, ledger.Event{Kind: ledger.ExitOK})
	apply(t2, ledger.Event{Kind: ledger.Bounce})
	launch(t2, 2, "claude+opus")
	exit(t2, 2, OutOK)
	apply(t2, ledger.Event{Kind: ledger.ExitOK})

	t3 := add("watch 直接转失败，没有 exit 记录")
	launch(t3, 1, "agy+gemini-3.8-flash-high")
	apply(t3, ledger.Event{Kind: ledger.ExitFail})

	t4 := add("还在跑")
	launch(t4, 1, "agy+gemini-3.8-flash-high")

	t5 := add("跟随工具缺省：退出记录带上工具报的模型")
	launch(t5, 1, "codex:high")
	raw, _ := json.Marshal(Exit{N: 1, Model: "gpt-6.1-sol", Outcome: OutOK})
	must(ledger.Record(ctx, db, t5, ExitKind, "runtime", string(raw)))

	stats, err := Stats(ctx, db)
	must(err)
	outs := func(k string) []string {
		var o []string
		for _, a := range stats[k] {
			o = append(o, a.Task+":"+a.Outcome)
		}
		return o
	}
	if got := outs("agy+gemini-3.8-flash-high"); len(got) != 2 || got[0] != t3+":fail" || got[1] != t1+":quota" {
		t.Errorf("agy 应记 其他失败、额度（新的在前），还在跑的不计：%v", got)
	}
	if got := outs("claude+opus"); len(got) != 3 || got[0] != t2+":ok" || got[1] != t2+":bounce" || got[2] != t1+":ok" {
		t.Errorf("claude+opus 应记 交付、被交回、交付（强度并进来）：%v", got)
	}
	if _, ok := stats["claude+opus:high"]; ok {
		t.Error("强度不单列")
	}
	if s := Count(stats["agy+gemini-3.8-flash-high"]); s != (Stat{Launches: 2, Quota: 1, Fail: 1}) {
		t.Errorf("agy 计数：%+v", s)
	}
	if s := Count(stats["claude+opus"]); s != (Stat{Launches: 3, OK: 2, Bounce: 1}) {
		t.Errorf("claude 计数：%+v", s)
	}
	if n := Fails(stats["agy+gemini-3.8-flash-high"], 5); n != 2 {
		t.Errorf("agy 近 5 次启动失败应为 2：%d", n)
	}
	if n := Fails(stats["claude+opus"], 5); n != 0 {
		t.Errorf("被交回不算启动失败：%d", n)
	}
	if b := stats["claude+opus"][1]; b.Reason != "bounce" {
		t.Errorf("被交回的原因取交回记录：%+v", b)
	}
	if a := stats["codex"]; len(a) != 1 || a[0].Model != "gpt-6.1-sol" || a[0].Outcome != OutOK {
		t.Errorf("跟随的执行者按工具归，明细带实际模型：%+v", a)
	}
	if a := stats["agy+gemini-3.8-flash-high"][0]; a.Model != "" {
		t.Errorf("没有退出记录的不编模型：%+v", a)
	}

	d, err := Show(ctx, db, "claude+opus:high")
	must(err)
	if d.Stat == nil || d.Stat.Launches != 3 || len(d.Attempts) != 3 {
		t.Errorf("workers <执行者> 应给这个「工具+模型」的明细：%+v", d)
	}
}

func TestRecentWindow(t *testing.T) {
	var ls []Attempt
	for i := range 30 {
		out := OutOK
		if i >= 27 {
			out = OutQuota
		}
		ls = append(ls, Attempt{Worker: "claude+opus", Outcome: out, At: int64(i)})
	}
	ls = append(ls, Attempt{Worker: "claude+opus", At: 99}) // 还在跑
	got := Recent(ls, StatWindow)["claude+opus"]
	if len(got) != StatWindow || got[0].At != 29 {
		t.Fatalf("应取最近 %d 次有结果的，新的在前：%d %+v", StatWindow, len(got), got[0])
	}
	if n := Fails(got, 5); n != 3 {
		t.Errorf("近 5 次启动失败：%d", n)
	}
}
