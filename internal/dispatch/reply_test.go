package dispatch

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func TestExitRecordsCurrentReply(t *testing.T) {
	piEnd := "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"缺陷\\n审阅结论：打回\"}]}}\n" +
		"{\"type\":\"agent_end\",\"messages\":[{\"role\":\"user\",\"content\":\"" + strings.Repeat("x", 200*1024) + "\"}]}\n" +
		"{\"type\":\"agent_settled\"}\n"
	for _, c := range []struct{ name, tool, log, want string }{
		{"Pi收尾大于日志尾巴", "pi", piEnd, "缺陷\n审阅结论：打回"},
		{"Kimi正文", "kimi", "{\"role\":\"assistant\",\"content\":\"审阅结论：打回\"}\n{\"role\":\"meta\",\"type\":\"session.resume_hint\"}\n", "审阅结论：打回"},
		{"Kimi空回复", "kimi", "{\"role\":\"tool\",\"content\":\"审阅结论：通过\"}\n", ""},
		{"Codex正文", "codex", "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"审阅结论：打回\"}}\n", "审阅结论：打回"},
		{"Codex空回复", "codex", "{\"type\":\"turn.completed\"}\n", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			ctx := context.Background()
			dir := t.TempDir()
			db, err := store.Open(filepath.Join(dir, "a.db"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { db.Close() })
			task, err := ledger.Add(ctx, db, ledger.NewTask{Title: "回复隔离测试"}, "u1")
			if err != nil {
				t.Fatal(err)
			}
			for _, kind := range []ledger.EventKind{ledger.Enqueue, ledger.Start} {
				if _, err := ledger.Apply(ctx, db, task.ID, ledger.Event{Kind: kind}, "dispatch", ""); err != nil {
					t.Fatal(err)
				}
			}
			if err := ledger.Record(ctx, db, task.ID, gates.KindResult, "dispatch", "审阅结论：通过"); err != nil {
				t.Fatal(err)
			}
			log := filepath.Join(dir, "run-2.log")
			if err := os.WriteFile(log, []byte(c.log), 0600); err != nil {
				t.Fatal(err)
			}
			run := workers.Run{N: 2, Worker: c.tool, Dir: dir, Log: log}
			b, _ := json.Marshal(run)
			if err := ledger.Record(ctx, db, task.ID, workers.RunKind, "dispatch", string(b)); err != nil {
				t.Fatal(err)
			}
			adapter, _ := workers.Builtin(c.tool)
			d := &dispatcher{env: &app.Env{DB: db, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}}
			if err := d.exited(ctx, &proc{task: task.ID, run: run, adapter: adapter}, 0); err != nil {
				t.Fatal(err)
			}
			reply, found, err := gates.Last(ctx, db, task.ID, gates.KindResult)
			if err != nil || !found || reply != c.want {
				t.Fatalf("reply=%q found=%v err=%v", reply, found, err)
			}
		})
	}
}
