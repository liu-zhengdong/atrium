package web

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 只装配只读路由，不启动调度、额度读取或真实执行者。
func TestQualityBrowser(t *testing.T) {
	out := os.Getenv("ATRIUM_QUALITY_TEST")
	if out == "" {
		t.Skip("未指定隔离验证目录")
	}
	ctx := context.Background()
	data := t.TempDir()
	db, err := store.Open(filepath.Join(data, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	num := func(v float64) *float64 { return &v }
	cases := map[string][]workers.Usage{
		"complete": {{Cost: num(2), Currency: "USD"}, {Cost: num(4), Currency: "USD"}},
		"partial":  {{Cost: num(2), Currency: "USD"}, {}, {}},
		"missing":  {{}},
		"zero":     {{Cost: num(0), Currency: "USD"}},
		"currency": {{Cost: num(7), Currency: "CNY", USD: num(1)}, {Cost: num(2), Currency: "USD"}},
		"bad":      {{Cost: num(-1), Currency: "USD"}, {Cost: num(0), Currency: "USD", Missing: []string{"输入"}}, {Cost: num(7), Currency: "CNY"}},
	}
	for name, uses := range cases {
		source := "---\nmodel: " + name + "\n---\n隔离成本样本"
		_, err := workers.SaveProfile(ctx, db, "combos/codex+"+name, workers.Edit{Source: &source}, "u1")
		must(err)
		task, err := ledger.Add(ctx, db, ledger.NewTask{Title: name}, "u1")
		must(err)
		for i, u := range uses {
			run, _ := json.Marshal(workers.Run{N: i + 1, Worker: "codex+" + name, Host: "h0"})
			outcome := workers.OutOK
			if name == "partial" && i > 0 {
				if i == 1 {
					outcome = workers.OutQuota
				} else {
					outcome = workers.OutSetup
				}
			}
			exit, _ := json.Marshal(workers.Exit{Outcome: outcome, Usage: u})
			must(ledger.Record(ctx, db, task.ID, workers.RunKind, "runtime", string(run)))
			must(ledger.Record(ctx, db, task.ID, workers.ExitKind, "runtime", string(exit)))
		}
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := api.NewRouter(logger)
	router.AddAuth(func(token string) (api.Actor, bool) {
		return api.Actor{ID: "u1", Kind: "user"}, token == "isolated-test"
	})
	srv := httptest.NewServer(router)
	defer srv.Close()
	port, _ := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	Module().Routes(router, &app.Env{DB: db, Paths: config.Paths{Data: data}, Port: port, Log: logger})
	router.Handle("GET /api/workers/quality", func(q *api.Req) (any, error) { return workers.ReadQuality(q.Context(), db) })
	// 真实 CLI 二进制只访问本测试路由；环境全部显式给定。
	for _, flags := range [][]string{{"workers", "--quality"}, {"workers", "--quality", "--json"}} {
		cmd := exec.Command(os.Getenv("ATRIUM_QUALITY_BIN"), flags...)
		cmd.Env = []string{"HOME=" + data, "ATRIUM_WORKER=1", "ATRIUM_WORKER_TOKEN=isolated-test", "ATRIUM_SERVER=" + srv.URL}
		b, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("CLI: %v %s", err, b)
		}
		name := "cli.txt"
		if len(flags) == 3 {
			name = "cli.json"
		}
		must(os.WriteFile(filepath.Join(out, name), b, 0600))
	}
	ready, _ := json.Marshal(map[string]string{"base": srv.URL})
	must(os.WriteFile(filepath.Join(out, "ready.json"), ready, 0600))
	deadline := time.After(2 * time.Minute)
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-deadline:
			t.Fatal("无头验证超时")
		case <-tick.C:
			if _, err := os.Stat(filepath.Join(out, "done")); err == nil {
				return
			}
		}
	}
}
