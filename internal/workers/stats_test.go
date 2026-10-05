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

// 同一任务先在一个组合上撞额度、再换另一个组合完成：两边各记各的；另有被交回、watch 直接收尾、还在跑的。
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
		_, err := db.ExecContext(ctx, `UPDATE task_events SET at = ? WHERE id = (SELECT MAX(id) FROM task_events WHERE task = ? AND kind = ?)`, at, id, RunKind)
		must(err)
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
	launch(t1, 1, "dsh+deepseek/deepseek-v4.1-flash")
	exit(t1, 1, OutQuota)
	apply(t1, ledger.Event{Kind: ledger.ExitFail})
	apply(t1, ledger.Event{Kind: ledger.Enqueue})
	launch(t1, 2, "dsh+deepseek/deepseek-v4:high")
	exit(t1, 2, OutOK)
	apply(t1, ledger.Event{Kind: ledger.ExitOK})
	apply(t1, ledger.Event{Kind: ledger.GatePass})

	t2 := add("被交付检查交回一次")
	launch(t2, 1, "dsh+deepseek/deepseek-v4")
	exit(t2, 1, OutOK)
	apply(t2, ledger.Event{Kind: ledger.ExitOK})
	apply(t2, ledger.Event{Kind: ledger.Bounce})
	launch(t2, 2, "dsh+deepseek/deepseek-v4")
	exit(t2, 2, OutOK)
	apply(t2, ledger.Event{Kind: ledger.ExitOK})

	t3 := add("watch 直接转失败，没有 exit 记录")
	launch(t3, 1, "dsh+deepseek/deepseek-v4.1-flash")
	apply(t3, ledger.Event{Kind: ledger.ExitFail})

	t4 := add("还在跑")
	launch(t4, 1, "dsh+deepseek/deepseek-v4.1-flash")

	t5 := add("跟随工具缺省：退出记录带上工具报的模型")
	launch(t5, 1, "dsh:high")
	raw, _ := json.Marshal(Exit{N: 1, Model: "gpt-6.1-sol", Outcome: OutOK})
	must(ledger.Record(ctx, db, t5, ExitKind, "runtime", string(raw)))

	// 这组验证结果归属与排序；缺失退出时间时，用时应保持空。
	_, err = db.ExecContext(ctx, `UPDATE task_events SET at = 0 WHERE kind IN ('exit', 'exit_ok', 'exit_fail')`)
	must(err)
	stats, err := Stats(ctx, db)
	must(err)
	outs := func(k string) []string {
		var o []string
		for _, a := range stats[k] {
			o = append(o, a.Task+":"+a.Outcome)
		}
		return o
	}
	if got := outs("dsh+deepseek/deepseek-v4.1-flash"); len(got) != 2 || got[0] != t3+":fail" || got[1] != t1+":quota" {
		t.Errorf("agy 应记 其他失败、额度（新的在前），还在跑的不计：%v", got)
	}
	if got := outs("dsh+deepseek/deepseek-v4"); len(got) != 3 || got[0] != t2+":ok" || got[1] != t2+":bounce" || got[2] != t1+":ok" {
		t.Errorf("claude+opus 应记 交付、被交回、交付（强度并进来）：%v", got)
	}
	if _, ok := stats["dsh+deepseek/deepseek-v4:high"]; ok {
		t.Error("强度不单列")
	}
	if s := Count(stats["dsh+deepseek/deepseek-v4.1-flash"]); [6]int{s.Launches, s.OK, s.Bounce, s.Quota, s.Setup, s.Fail} != [6]int{2, 0, 0, 1, 0, 1} {
		t.Errorf("agy 计数：%+v", s)
	}
	if s := Count(stats["dsh+deepseek/deepseek-v4"]); [6]int{s.Launches, s.OK, s.Bounce, s.Quota, s.Setup, s.Fail} != [6]int{3, 2, 1, 0, 0, 0} {
		t.Errorf("claude 计数：%+v", s)
	}
	if n := Fails(stats["dsh+deepseek/deepseek-v4.1-flash"], 5); n != 2 {
		t.Errorf("agy 近 5 次启动失败应为 2：%d", n)
	}
	if n := Fails(stats["dsh+deepseek/deepseek-v4"], 5); n != 0 {
		t.Errorf("被交回不算启动失败：%d", n)
	}
	if b := stats["dsh+deepseek/deepseek-v4"][1]; b.Reason != "bounce" {
		t.Errorf("被交回的原因取交回记录：%+v", b)
	}
	if a := stats["dsh"]; len(a) != 1 || a[0].Model != "gpt-6.1-sol" || a[0].Outcome != OutOK {
		t.Errorf("跟随的执行者按工具归，明细带实际模型：%+v", a)
	}
	if a := stats["dsh+deepseek/deepseek-v4.1-flash"][0]; a.Model != "" {
		t.Errorf("没有退出记录的不编模型：%+v", a)
	}

	d, err := Show(ctx, db, "dsh+deepseek/deepseek-v4:high")
	must(err)
	if d.Stat == nil || d.Stat.Launches != 3 || len(d.Attempts) != 3 {
		t.Errorf("workers <执行者> 应给这个「工具+模型」的明细：%+v", d)
	}
	rows, err := List(ctx, db)
	must(err)
	for _, row := range rows {
		want := stats[Combo(row.ID)]
		if len(row.Recent) != len(want) {
			t.Fatalf("%s 结果数量：%v", row.ID, row.Recent)
		}
		for i, a := range want {
			if row.Recent[i] != a.Outcome {
				t.Fatalf("%s 结果顺序：%v", row.ID, row.Recent)
			}
		}
	}

}

func TestRecentWindow(t *testing.T) {
	var ls []Attempt
	for i := range 30 {
		out := OutOK
		if i >= 27 {
			out = OutQuota
		}
		ls = append(ls, Attempt{Worker: "dsh+deepseek/deepseek-v4", Outcome: out, At: int64(i)})
	}
	ls = append(ls, Attempt{Worker: "dsh+deepseek/deepseek-v4", At: 99}) // 还在跑
	got := Recent(ls, StatWindow, Combo)["dsh+deepseek/deepseek-v4"]
	if len(got) != StatWindow || got[0].At != 29 {
		t.Fatalf("应取最近 %d 次有结果的，新的在前：%d %+v", StatWindow, len(got), got[0])
	}
	if n := Fails(got, 5); n != 3 {
		t.Errorf("近 5 次启动失败：%d", n)
	}
}

// 只写工具名派活的拉起（历史记录的写法）归进目录里那个组合，不再拆成两份；目录里没有的原样进「不在目录里」。
func TestStatsMergesPlainTool(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// harness 写了缺省模型，只写工具名的派活才归得进这个组合。
	src := "---\nmodel: deepseek/deepseek-v4\n---\n"
	if _, err := SaveProfile(ctx, db, "harness/dsh", Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	// 拉起时间取窗口内，Show 的质量行才读得到。
	at := store.Now() - QualityWindow.Milliseconds() + 1000
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
		_, err := db.ExecContext(ctx, `UPDATE task_events SET at = ? WHERE id = (SELECT MAX(id) FROM task_events WHERE task = ? AND kind = ?)`, at, id, RunKind)
		must(err)
	}
	exit := func(id string, n int, out string) {
		t.Helper()
		raw, _ := json.Marshal(Exit{N: n, Outcome: out})
		must(ledger.Record(ctx, db, id, ExitKind, "runtime", string(raw)))
	}
	add := func(title string) string {
		t.Helper()
		tk, err := ledger.Add(ctx, db, ledger.NewTask{Title: title}, "u1")
		must(err)
		apply(tk.ID, ledger.Event{Kind: ledger.Enqueue})
		return tk.ID
	}

	t1 := add("只写工具名派活")
	launch(t1, 1, "dsh")
	exit(t1, 1, OutOK)
	apply(t1, ledger.Event{Kind: ledger.ExitOK})
	t2 := add("写全组合派活")
	launch(t2, 1, "dsh+deepseek/deepseek-v4:high")
	exit(t2, 1, OutOK)
	apply(t2, ledger.Event{Kind: ledger.ExitOK})
	t3 := add("目录里没有的执行者")
	launch(t3, 1, "ghost")
	exit(t3, 1, OutFail)
	apply(t3, ledger.Event{Kind: ledger.ExitFail})

	stats, err := Stats(ctx, db)
	must(err)
	if s := stats["dsh+deepseek/deepseek-v4"]; len(s) != 2 || s[0].Task != t2 || s[1].Task != t1 {
		t.Fatalf("只写工具名与写全组合应归并成一个键，新的在前：%+v", s)
	}
	if _, ok := stats["dsh"]; ok {
		t.Fatal("不应再按「dsh」单列")
	}
	if _, ok := stats["ghost"]; !ok {
		t.Fatal("目录里没有的执行者原样保留")
	}

	rows, err := List(ctx, db)
	must(err)
	var extra []string
	for _, row := range rows {
		if row.ID == "dsh+deepseek/deepseek-v4" && row.Stat.Launches != 2 {
			t.Fatalf("目录行应拿到归并后的统计：%+v", row.Stat)
		}
		if row.Problem != "" {
			extra = append(extra, row.ID)
		}
	}
	if len(extra) != 1 || extra[0] != "ghost" {
		t.Fatalf("「不在目录里」只剩 ghost：%v", extra)
	}

	d, err := Show(ctx, db, "dsh+deepseek/deepseek-v4")
	must(err)
	if d.Stat == nil || d.Stat.Launches != 2 || d.Quality == nil || d.Quality.Launches != 2 {
		t.Fatalf("抽屉的近期与质量都按归并后的口径：%+v %+v", d.Stat, d.Quality)
	}
}

// 统计键跟着目录走：harness 写了 model 就按它归；未知工具、写错的标识原样返回。
func TestStatKeys(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	src := "---\ntrust: low\nmodel: deepseek/deepseek-v4\n---\n"
	if _, err := SaveProfile(ctx, db, "harness/dsh", Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	keys, err := statKeys(ctx, db, []string{"dsh", "dsh+deepseek/deepseek-v4.1-flash", "dsh:high", "ghost", "写不对"})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"dsh":                              "dsh+deepseek/deepseek-v4",         // harness 写了 model，按目录归
		"dsh+deepseek/deepseek-v4.1-flash": "dsh+deepseek/deepseek-v4.1-flash", // 写明模型的不动
		"dsh:high":                         "dsh+deepseek/deepseek-v4",         // 强度不单列
		"ghost":                            "ghost",                            // 未知工具解析不了，原样落「不在目录里」
		"写不对":                              "写不对",
	}
	for id, k := range want {
		if keys[id] != k {
			t.Errorf("%s → %q，应为 %q", id, keys[id], k)
		}
	}
}
