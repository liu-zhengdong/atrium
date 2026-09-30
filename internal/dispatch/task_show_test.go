package dispatch

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/watch"
)

// 隔离 HTTP 实例使用真实任务、事件、等待对象路由与执行者认证，不拉起模型。
func TestWorkerTaskShow(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := os.WriteFile(env.Paths.Token(), []byte("test-user-token"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	task, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "执行者查任务", Detail: "任务事实"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []ledger.EventKind{ledger.Enqueue, ledger.Start} {
		if _, err := ledger.Apply(ctx, env.DB, task.ID, ledger.Event{Kind: kind}, "u1", "测试"); err != nil {
			t.Fatal(err)
		}
	}
	r := api.NewRouter(env.Log)
	r.AddAuth(authWorker(env))
	r.AddGuard("worker", workerGuard(env))
	ledger.Routes(r, env)
	events.Routes(r, env)
	watch.Routes(r, env)
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		paths = append(paths, req.URL.Path)
		r.ServeHTTP(w, req)
	}))
	defer srv.Close()
	token := workerToken("test-user-token", task.ID, 1)
	vars := map[string]string{"ATRIUM_WORKER": "1", "ATRIUM_WORKER_TOKEN": token, "ATRIUM_SERVER": srv.URL}
	table := cli.NewTable("atrium", "测试")
	ledger.Commands(table)
	for _, jsonMode := range []bool{false, true} {
		paths = nil
		var out, stderr strings.Builder
		args := []string{"task", "show", task.ID}
		if jsonMode {
			args = append(args, "--json")
		}
		code := table.Main(ctx, args, cli.Env{Stdout: &out, Stderr: &stderr, Getenv: func(k string) string { return vars[k] }})
		if code != 0 || !strings.Contains(out.String(), task.Title) || !strings.Contains(out.String(), task.Detail) || !strings.Contains(out.String(), "running") {
			t.Fatalf("json=%v code=%d stdout=%s stderr=%s", jsonMode, code, &out, &stderr)
		}
		want := "/api/tasks/" + task.ID + ",/api/tasks/" + task.ID + "/holder"
		if got := strings.Join(paths, ","); got != want {
			t.Fatalf("请求=%s，期望=%s", got, want)
		}
		if !jsonMode && !strings.Contains(out.String(), "atrium task wait "+task.ID) {
			t.Fatal("执行者应保留 task wait 下一步")
		}
		t.Logf("task show json=%v：成功，仅请求任务及 holder", jsonMode)
	}
	c := &api.Client{Base: srv.URL, Token: token}
	var ae *api.Error
	if err := c.Do(ctx, "GET", "/api/events/pushed", nil, nil); !errors.As(err, &ae) || ae.Code != "forbidden" {
		t.Fatalf("执行者读取 pushed 应仍被拒绝：%v", err)
	}
	t.Log("GET /api/events/pushed：仍为 forbidden")
}
