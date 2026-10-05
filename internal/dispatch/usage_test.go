package dispatch

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func TestExitUsageSnapshot(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	task, err := ledger.Add(ctx, db, ledger.NewTask{Title: "用量快照"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	src := "---\nbilling: subscription\nprices: {currency: USD, input: 2, output: 10, cache_read: 0.2, cache_write: 3}\n---\n"
	if _, err := workers.SaveProfile(ctx, db, "harness/dsh", workers.Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	run := workers.Run{N: 1, Worker: "dsh", Log: filepath.Join(t.TempDir(), "run.log")}
	log := `{"type":"session","sessionId":"session-0123abcd-0123-0123-0123-0123456789ab"}` + "\n" +
		`{"type":"status","phase":"step_end","turn":1,"usage":{"inputTokens":100,"outputTokens":20,"cacheReadTokens":1000,"cacheWriteTokens":10}}` + "\n"
	if err := os.WriteFile(run.Log, []byte(log), 0600); err != nil {
		t.Fatal(err)
	}
	if err := recordExit(ctx, db, task.ID, run, workers.Exit{N: 1, Outcome: workers.OutOK}); err != nil {
		t.Fatal(err)
	}
	u, err := workers.ExitUsage(ctx, db, task.ID, 1)
	if err != nil || u.Cost == nil || u.Source != "estimate" || u.Billing != "subscription" {
		t.Fatalf("%+v %v", u, err)
	}
	if !strings.Contains(logHeader(task.ID, LogChunk{Run: 1, Worker: run.Worker, Usage: u}), "折合") {
		t.Fatal(u)
	}
	// 改档案与日志后仍读当次快照；重记不会覆盖它。
	src = "---\nbilling: metered\n---\n"
	workers.SaveProfile(ctx, db, "harness/dsh", workers.Edit{Source: &src}, "u1")
	os.WriteFile(run.Log, []byte("无读数\n"), 0600)
	if err := recordExit(ctx, db, task.ID, run, workers.Exit{N: 1, Outcome: workers.OutFail}); err != nil {
		t.Fatal(err)
	}
	got, err := workers.ExitUsage(ctx, db, task.ID, 1)
	if err != nil || got.Cost == nil || *got.Cost != *u.Cost || got.Billing != u.Billing {
		t.Fatalf("%+v %v", got, err)
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM task_events WHERE task = ? AND kind = 'exit'`, task.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("%d %v", count, err)
	}
	// 另一次日志故意没有用量，退出 JSON 保存 null，给人显示读不到。
	run.N = 2
	if err := recordExit(ctx, db, task.ID, run, workers.Exit{N: 2, Outcome: workers.OutOK}); err != nil {
		t.Fatal(err)
	}
	got, err = workers.ExitUsage(ctx, db, task.ID, 2)
	if err != nil || got.Input != nil || got.Cost != nil || !strings.Contains(got.String(), "读不到") {
		t.Fatal(got, err)
	}
}

func TestSpecExitUsage(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	task, err := ledger.Add(ctx, db, ledger.NewTask{Title: "档案声明用量"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	// 档案自己声明从哪种事件、哪些字段取用量：日志格式随便哪个工具都行。
	src := `---
usage:
  event: result
  input: usage.input_tokens
  output: usage.output_tokens
  cache_read: usage.cache_read_input_tokens
  cache_write: usage.cache_creation_input_tokens
  cost: total_cost_usd
  currency: USD
billing: metered
prices: {currency: CNY, input: 6, output: 30, cache_read: 1.2}
---
`
	if _, err := workers.SaveProfile(ctx, db, "harness/dsh", workers.Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	run := workers.Run{N: 1, Worker: "dsh", Log: filepath.Join(t.TempDir(), "run.log")}
	log := `{"type":"result","subtype":"success","usage":{"input_tokens":1000000,"output_tokens":1000000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"total_cost_usd":0}` + "\n"
	if err := os.WriteFile(run.Log, []byte(log), 0600); err != nil {
		t.Fatal(err)
	}
	if err := recordExit(ctx, db, task.ID, run, workers.Exit{N: 1, Outcome: workers.OutOK}); err != nil {
		t.Fatal(err)
	}
	u, err := workers.ExitUsage(ctx, db, task.ID, 1)
	if err != nil || u.Source != "estimate" || u.Billing != "metered" || u.Currency != "CNY" || u.Cost == nil || *u.Cost != 36 {
		t.Fatalf("%+v %v", u, err)
	}
	head := logHeader(task.ID, LogChunk{Run: 1, Worker: run.Worker, Usage: u})
	if !strings.Contains(head, "花费") || !strings.Contains(head, "估算") || !strings.Contains(head, "CNY") {
		t.Fatal(head)
	}
	text, err := workers.ExitText(`{"n":1,"outcome":"ok","usage":` + mustJSON(t, u) + `}`)
	if err != nil || !strings.Contains(text, "花费 CNY 36") {
		t.Fatal(text, err)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestStoppedExitUsage(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	task, err := ledger.Add(ctx, db, ledger.NewTask{Title: "停止后保留用量"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []ledger.EventKind{ledger.Enqueue, ledger.Start, ledger.Block} {
		if _, err := ledger.Apply(ctx, db, task.ID, ledger.Event{Kind: kind}, "u1", "测试"); err != nil {
			t.Fatal(err)
		}
	}
	run := workers.Run{N: 1, Worker: "dsh", Log: filepath.Join(t.TempDir(), "run.log")}
	log := `{"type":"status","phase":"step_end","turn":1,"usage":{"inputTokens":112,"outputTokens":7,"cacheReadTokens":3,"cacheWriteTokens":1}}` + "\n"
	if err := os.WriteFile(run.Log, []byte(log), 0600); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(run)
	if err := ledger.Record(ctx, db, task.ID, workers.RunKind, "runtime", string(body)); err != nil {
		t.Fatal(err)
	}
	d := dispatcher{env: &app.Env{DB: db}}
	if err := d.exited(ctx, &proc{task: task.ID, run: run}, 0); err != nil {
		t.Fatal(err)
	}
	u, err := workers.ExitUsage(ctx, db, task.ID, 1)
	if err != nil || u.Input == nil || *u.Input != 112 || u.Output == nil || *u.Output != 7 {
		t.Fatal(u, err)
	}
	got, err := ledger.Get(ctx, db, task.ID)
	if err != nil || got.Status != ledger.Blocked {
		t.Fatal("只记用量，不改变停止状态", got, err)
	}
}
