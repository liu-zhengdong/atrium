package main

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestTaskAcceptancePermissions(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	top, err := org.AddLeader(ctx, db, org.NewLeader{Name: "上级", Workers: []string{"fake"}})
	if err != nil {
		t.Fatal(err)
	}
	low, err := org.AddLeader(ctx, db, org.NewLeader{Name: "下级", Workers: []string{"fake"}})
	if err != nil {
		t.Fatal(err)
	}
	root, err := org.Add(ctx, db, org.NewDept{Name: "上级", Leader: top.ID})
	if err != nil {
		t.Fatal(err)
	}
	dept, err := org.Add(ctx, db, org.NewDept{Name: "下级", Parent: root.ID, Leader: low.ID})
	if err != nil {
		t.Fatal(err)
	}
	task, err := ledger.Add(ctx, db, ledger.NewTask{Title: "暂缓", Org: dept.ID}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Pause: &pause.Store{DB: db}}
	router := api.NewRouter(env.Log)
	for _, m := range modules() {
		if m.Routes != nil {
			m.Routes(router, env)
		}
	}
	actors := map[string]api.Actor{"test-top": {ID: top.ID, Kind: "leader"}, "test-low": {ID: low.ID, Kind: "leader"}, "test-worker": {ID: task.ID, Kind: "worker"}, "test-user": {ID: "u1", Kind: "user"}}
	router.AddAuth(func(token string) (api.Actor, bool) { a, ok := actors[token]; return a, ok })
	request := func(method, suffix, body, who string, want int) {
		t.Helper()
		r := httptest.NewRequest(method, "/api/tasks/"+task.ID+suffix, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+who)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s 得到 %d，要 %d：%s", method, suffix, w.Code, want, w.Body.String())
		}
	}
	request("PATCH", "", `{"accept":"hold","note":"目标未完成"}`, "test-top", 200)
	request("PATCH", "", `{"accept":"resume","note":"下级越权"}`, "test-low", 403)
	request("PATCH", "", `{"accept":"hold","note":"下级覆盖"}`, "test-low", 403)
	request("PATCH", "", `{"status":"done"}`, "test-low", 409)
	request("PATCH", "", `{"accept":"resume","note":"执行者越权"}`, "test-worker", 403)
	for _, ev := range []ledger.Event{{Kind: ledger.Enqueue}, {Kind: ledger.Start}, {Kind: ledger.ExitOK}, {Kind: ledger.GatePass}} {
		if _, err := ledger.Apply(ctx, db, task.ID, ev, "runtime", ""); err != nil {
			t.Fatal(err)
		}
	}
	request("POST", "/accept", `{}`, "test-low", 403)
	accept := org.AcceptUser
	if _, err := org.Edit(ctx, db, dept.ID, org.DeptPatch{Accept: &accept}); err != nil {
		t.Fatal(err)
	}
	request("POST", "/accept", `{}`, "test-top", 403)
	request("POST", "/accept", `{}`, "test-worker", 403)
	request("PATCH", "", `{"accept":"resume","note":"上级解除"}`, "test-top", 200)
	t.Log("真实装配路由：下级覆盖/解除/验收与执行者写决定 403，直接完成 409；部门用户验收未被任务决定放宽")
}
