package dispatch

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
)

func TestWorkerTokenParse(t *testing.T) {
	tok := workerToken("k", "t12", 3)
	if task, n, ok := parseWorkerToken("k", tok); !ok || task != "t12" || n != 3 {
		t.Fatalf("%s → %s %d %v", tok, task, n, ok)
	}
	for _, bad := range []string{
		tok[:len(tok)-1] + "0",                // 签名改了
		strings.Replace(tok, "_3_", "_4_", 1), // 换了第几次
		strings.Replace(tok, "t12", "t13", 1), // 换了任务
		"wt_t12_3", "wt_x1_3_" + workerMAC("k", "x1", 3), "lt_abc", "",
	} {
		if _, _, ok := parseWorkerToken("k", bad); ok {
			t.Errorf("%q 不该认", bad)
		}
	}
	if _, _, ok := parseWorkerToken("另一把钥匙", tok); ok {
		t.Error("轮换用户令牌后旧的执行者令牌应作废")
	}
}

func TestWorkerLive(t *testing.T) {
	cases := []struct {
		status ledger.Status
		stage  ledger.Stage
		lastN  int
		n      int
		want   bool
	}{
		{ledger.Running, ledger.StageNone, 2, 2, true},
		{ledger.Queued, ledger.StageNone, 0, 1, true},   // 拉起到落账之间
		{ledger.Running, ledger.StageNone, 1, 2, true},  // 重派到落账之间
		{ledger.Running, ledger.StageGate, 2, 2, false}, // 退出进了关卡
		{ledger.Queued, ledger.StageNone, 2, 2, false},  // 退出后重新排队
		{ledger.Done, ledger.StageNone, 2, 2, false},
		{ledger.Running, ledger.StageNone, 3, 2, false}, // 已有新一次拉起
		{ledger.Running, ledger.StageNone, 1, 3, false},
	}
	for _, c := range cases {
		if got := WorkerLive(c.status, c.stage, c.lastN, c.n); got != c.want {
			t.Errorf("%+v → %v", c, got)
		}
	}
}

func TestWorkerRule(t *testing.T) {
	cases := map[string]WorkerAccess{
		"GET /api/tasks":                   WorkerRead,
		"GET /api/materials/{id}":          WorkerRead,
		"GET /api/skills/{name}":           WorkerRead,
		"POST /api/skills":                 WorkerDeny,
		"GET /api/tasks/{id}/log":          WorkerRead,
		"POST /api/materials":              WorkerMaterial,
		"POST /api/materials/{id}/revs":    WorkerMaterial,
		"POST /api/materials/{id}/archive": WorkerDeny,
		"POST /api/tasks":                  WorkerDeny,
		"PATCH /api/tasks/{id}":            WorkerDeny,
		"POST /api/tasks/{id}/notes":       WorkerDeny,
		"GET /api/events/wait":             WorkerDeny,
		"GET /api/service":                 WorkerDeny,
		"POST /api/service/stop":           WorkerDeny,
		"POST /api/auth/rotate":            WorkerDeny,
		"GET /ui/x":                        WorkerDeny,
	}
	for p, want := range cases {
		if got := WorkerRule(p); got != want {
			t.Errorf("%s → %v，应为 %v", p, got, want)
		}
	}
	for _, c := range []struct {
		taskOrg, dept string
		overview      bool
		ok            bool
	}{{"o1", "o1", false, true}, {"o1", "o2", false, false}, {"o1", "o1", true, false}, {"", "o1", false, false}} {
		if err := WorkerMaterialCheck("t1", c.taskOrg, c.dept, c.overview); (err == nil) != c.ok {
			t.Errorf("%+v → %v", c, err)
		}
	}
}

// 经路由走一遍：在跑的执行者凭令牌能读、能往本部门加资料或给本部门的细节资料加一版（署名 tN 执行者），别的都拒；退出后令牌作废。
func TestWorkerTokenRoutes(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	o1, err := org.Add(ctx, env.DB, org.NewDept{Name: "公司"})
	if err != nil {
		t.Fatal(err)
	}
	o2, _ := org.Add(ctx, env.DB, org.NewDept{Name: "别处"})
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "长活", Org: o1.ID}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "kimi"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Status == ledger.Running })
	logf := filepath.Join(TaskDir(env.Paths.Data, tk.ID), "run-1.log")
	waitFor(t, env, tk.ID, func(ledger.Task) bool { b, _ := os.ReadFile(logf); return strings.Contains(string(b), "started") })
	if b, _ := os.ReadFile(logf); !strings.Contains(string(b), "server=http://127.0.0.1:") || !strings.Contains(string(b), "token=yes") {
		t.Errorf("本机执行者环境里要有服务地址与令牌：%s", b)
	}

	r := api.NewRouter(slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.AddAuth(authWorker(env))
	r.AddGuard("worker", workerGuard(env))
	var by string
	r.Handle("GET /api/tasks", func(q *api.Req) (any, error) { return "ok", nil })
	r.Handle("POST /api/tasks", func(q *api.Req) (any, error) { return "ok", nil })
	r.Handle("POST /api/materials", func(q *api.Req) (any, error) {
		var in org.MaterialInput
		by = q.Actor.ID
		return nil, q.DecodeMax(&in, org.MaxMaterialBody)
	})
	r.Handle("POST /api/materials/{id}/revs", func(q *api.Req) (any, error) { return "ok", nil })
	material := func(dept string, overview bool) string {
		m, err := org.AddMaterial(ctx, env.DB, env.Paths.Data, org.MaterialInput{Org: dept, Overview: overview, Note: "x",
			Files: []org.MaterialFile{{Name: "a.md", Content: []byte("x")}}}, "u1")
		if err != nil {
			t.Fatal(err)
		}
		return m.ID
	}
	mine, theirs, overview := material(o1.ID, false), material(o2.ID, false), material(o1.ID, true)
	srv := httptest.NewServer(r)
	defer srv.Close()
	token := workerToken("test-user-token", tk.ID, 1)
	c := &api.Client{Base: srv.URL, Token: token}
	code := func(err error) string {
		var ae *api.Error
		if errors.As(err, &ae) {
			return ae.Code
		}
		if err != nil {
			return err.Error()
		}
		return "ok"
	}
	add := func(dept string, overview bool) string {
		return code(c.Do(ctx, "POST", "/api/materials", org.MaterialInput{Org: dept, Overview: overview,
			Files: []org.MaterialFile{{Name: "a.md", Content: []byte("x")}}}, nil))
	}
	if got := code(c.Do(ctx, "GET", "/api/tasks", nil, nil)); got != "ok" {
		t.Errorf("读应放行：%s", got)
	}
	rev := func(id string) string {
		return code(c.Do(ctx, "POST", "/api/materials/"+id+"/revs", org.MaterialInput{Files: []org.MaterialFile{{Name: "a.md", Content: []byte("y")}}}, nil))
	}
	if got := add(o1.ID, false); got != "ok" || by != tk.ID+" 执行者" {
		t.Errorf("往本部门加资料应放行、署名 %s 执行者：%s %q", tk.ID, got, by)
	}
	if got := rev(mine); got != "ok" {
		t.Errorf("给本部门的细节资料加一版应放行：%s", got)
	}
	for what, got := range map[string]string{
		"别的部门":       add(o2.ID, false),
		"总览":         add(o1.ID, true),
		"给别的部门的资料加版": rev(theirs),
		"给总览加版":      rev(overview),
		"建任务":        code(c.Do(ctx, "POST", "/api/tasks", map[string]string{"title": "x"}, nil)),
	} {
		if got != "forbidden" {
			t.Errorf("%s 应拒：%s", what, got)
		}
	}
	bad := &api.Client{Base: srv.URL, Token: workerToken("别的钥匙", tk.ID, 1)}
	if got := code(bad.Do(ctx, "GET", "/api/tasks", nil, nil)); got != "unauthorized" {
		t.Errorf("签名不对应 401：%s", got)
	}
	// 停下：执行者退出后令牌作废。
	if _, err := ledger.Apply(ctx, env.DB, tk.ID, ledger.Event{Kind: ledger.Set, To: ledger.Blocked}, "u1", "不做了"); err != nil {
		t.Fatal(err)
	}
	if got := code(c.Do(ctx, "GET", "/api/tasks", nil, nil)); got != "unauthorized" {
		t.Errorf("任务不在跑了令牌应作废：%s", got)
	}
}
