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
	// 收尾那一段比日志尾巴还大：回复要从解析结果里取，不能只截日志尾巴。
	big := `{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"ls"}}` + "\n" +
		`{"type":"tool_result","callId":"c1","status":"completed","result":"` + strings.Repeat("x", 200*1024) + `"}`
	for _, c := range []struct{ name, log, want string }{
		{"dsh 收尾大于日志尾巴", big + "\n" + `{"type":"text","text":"缺陷\n审阅结论：打回"}` + "\n" +
			`{"type":"final","text":"缺陷\n审阅结论：打回"}`, "缺陷\n审阅结论：打回"},
		{"dsh 收尾是空的", `{"type":"final","text":""}`, ""},
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
			run := workers.Run{N: 2, Worker: "dsh", Dir: dir, Log: log}
			b, _ := json.Marshal(run)
			if err := ledger.Record(ctx, db, task.ID, workers.RunKind, "dispatch", string(b)); err != nil {
				t.Fatal(err)
			}
			adapter, _ := workers.Builtin("dsh")
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
