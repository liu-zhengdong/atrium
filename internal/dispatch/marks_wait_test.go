package dispatch

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/watch"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// markAll 把本机除 except 外的每个内置工具标成不可用一小时：此刻能接的只剩 except（或一个都没有）。
func markAll(t *testing.T, db *store.DB, except string) {
	t.Helper()
	now := store.Now()
	for _, tool := range workers.Tools {
		if tool == except {
			continue
		}
		m := workers.Mark{Tool: tool, Host: LocalHost, Kind: workers.SignalNoStart, Reason: "零步骤出错退出", Since: now, Until: now + time.Hour.Milliseconds()}
		if err := workers.SetMark(context.Background(), db, m); err != nil {
			t.Fatal(err)
		}
	}
}

func hasEvent(t *testing.T, db *store.DB, task, kind string) bool {
	t.Helper()
	h, err := ledger.History(context.Background(), db, task, 200)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range h {
		if e.Kind == kind {
			return true
		}
	}
	return false
}

func lastEvent(t *testing.T, db *store.DB, task, kind string) string {
	t.Helper()
	h, err := ledger.History(context.Background(), db, task, 200)
	if err != nil {
		t.Fatal(err)
	}
	body := ""
	for _, e := range h {
		if e.Kind == kind {
			body = e.Body
		}
	}
	return body
}

// t987：入队时能接的都被不可用标记挡着——留在队列里等、经历写明在等什么，不转受阻；标记解除后照常派出。
func TestQueuedWaitsForMarkedWorker(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	markAll(t, env.DB, "")
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "审阅"}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{}, "u1"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ { // 第二轮同样在等，不重复记
		if err := d.pump(ctx); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := ledger.Get(ctx, env.DB, tk.ID)
	if got.Status != ledger.Queued {
		t.Fatalf("标记挡着应留在队列里等：%+v", got)
	}
	h, _ := ledger.History(ctx, env.DB, tk.ID, 50)
	n := 0
	for _, e := range h {
		if e.Kind == "waiting" {
			n++
			if !strings.Contains(e.Body, "不可用") || !strings.Contains(e.Body, "恢复") {
				t.Errorf("经历应写明在等哪个标记恢复：%s", e.Body)
			}
		}
	}
	if n != 1 {
		t.Errorf("同样的等待只记一条，得到 %d 条", n)
	}
	if _, err := workers.ClearMarks(ctx, env.DB, "claude"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
	if run, _ := workers.LastRun(ctx, env.DB, tk.ID); run == nil || !strings.HasPrefix(run.Worker, "claude") || run.Why != workers.WhyFirst {
		t.Fatalf("标记解除后应派出：%+v", run)
	}
}

// t801：交回或点名的执行者在那台被标记挡着——同样排队等，不转受阻。
func TestPinnedWaitsForMark(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	markAll(t, env.DB, "")
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "续做"}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "claude", Host: LocalHost}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := ledger.Get(ctx, env.DB, tk.ID); got.Status != ledger.Queued || !strings.Contains(lastEvent(t, env.DB, tk.ID, "waiting"), "claude+opus 不可用") {
		t.Fatalf("点名的执行者被标记挡着应排队等：%+v %q", got, lastEvent(t, env.DB, tk.ID, "waiting"))
	}
}

// t865：执行者额度用尽要换人，能换的此刻都被标记挡着——放回队列（不转受阻、不发失败事件），换人次数接着数；
// 恢复后派出时记 switch。
func TestSwitchWaitsWhenAllMarked(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	markAll(t, env.DB, "codex")
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "返工"}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "codex"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !hasEvent(t, env.DB, tk.ID, string(ledger.Requeue)) {
		if time.Now().After(deadline) {
			got, _ := ledger.Get(ctx, env.DB, tk.ID)
			t.Fatalf("应放回队列：%+v", got)
		}
		time.Sleep(20 * time.Millisecond)
	}
	got, _ := ledger.Get(ctx, env.DB, tk.ID)
	items, err := queued(ctx, env.DB)
	if err != nil || got.Status != ledger.Queued || len(items) != 1 || !items[0].Opts.Switch || len(items[0].Opts.Avoid) != 0 {
		t.Fatalf("放回队列应接着这一轮数、额度用尽的 codex 不进 Avoid：%+v %+v %v", got, items, err)
	}
	var n int
	if err := env.DB.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE task = ? AND kind = ? AND (body LIKE '%"to":"failed"%' OR body LIKE '%"to":"blocked"%')`,
		tk.ID, events.TaskStatus).Scan(&n); err != nil || n != 0 {
		t.Fatalf("放回队列是过程，不该发失败或受阻：%d %v", n, err)
	}
	if _, err := workers.ClearMarks(ctx, env.DB, "claude"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
	runs, _ := workers.Runs(ctx, env.DB, tk.ID, 10)
	if len(runs) != 2 || !strings.HasPrefix(runs[1].Worker, "claude") || runs[1].Why != workers.WhySwitch {
		t.Fatalf("恢复后应换人派出并记 switch：%+v", runs)
	}
}

// t913：巡检判启动后没进展（没有日志信号）——换人重排、避开刚卡住的那位，不原样重派同一执行者。
func TestRequeueStartStuckSwitches(t *testing.T) {
	env, _ := setup(t)
	ctx := context.Background()
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "合入前等 CI"}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "kimi"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.Apply(ctx, env.DB, tk.ID, ledger.Event{Kind: ledger.Start}, actor, ""); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "run-1.log")
	os.WriteFile(log, nil, 0o600)
	raw, _ := json.Marshal(workers.Run{N: 1, Why: workers.WhyFirst, Worker: "kimi", Host: LocalHost, Risk: "low", Log: log, At: store.Now()})
	if err := ledger.Record(ctx, env.DB, tk.ID, workers.RunKind, actor, string(raw)); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.Apply(ctx, env.DB, tk.ID, ledger.Event{Kind: ledger.ExitFail}, actor, "3 分钟没动"); err != nil {
		t.Fatal(err)
	}
	if err := Requeue(ctx, env, tk.ID, watch.Why{Reason: "执行者在做（h1），3 分钟 没动", Worker: "kimi"}); err != nil {
		t.Fatal(err)
	}
	items, err := queued(ctx, env.DB)
	if err != nil || len(items) != 1 || items[0].Opts.Worker != "" || !slices.Equal(items[0].Opts.Avoid, []string{"kimi"}) || !items[0].Opts.Switch {
		t.Fatalf("启动卡住应换人、避开 kimi：%+v %v", items, err)
	}
}

func TestAvoidOf(t *testing.T) {
	tried := map[string]bool{"codex": true, "pi+opencode-go/a": true, "kimi": true}
	marked := func(s workers.Spec) bool { return s.Tool == "codex" }
	if got := avoidOf(tried, marked); !slices.Equal(got, []string{"kimi", "pi+opencode-go/a"}) {
		t.Fatalf("被标记的不避开、其余试过的避开：%v", got)
	}
}
