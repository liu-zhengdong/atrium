package dispatch

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func TestReviewRequirementsOnlyForReview(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "挑审阅者"}, "u1")
	// 内置只剩 dsh：审阅的「不同工具」这条只能靠点名（NotModel/MinTrust）与作者排除来测。
	for _, name := range []string{"dsh+author", "dsh+opus", "dsh+sonnet", "dsh+k2", "dsh+gpt"} {
		trust := "medium"
		if name == "dsh+k2" {
			trust = "low"
		}
		// 模型的 provider/模型写法要完整（dsh 只认 provider/模型），键又得跟标识里的不同，ID 才留在 combos/ 的名字上。
		src := "---\nmodel: rev/" + strings.TrimPrefix(name, "dsh+") + "-x\ntrust: " + trust + "\n---\n"
		if _, err := env.DB.ExecContext(ctx, `INSERT INTO worker_profiles(name,spec,updated_by,updated_at) VALUES(?,?,'u1',0)`, "combos/"+name, src); err != nil {
			t.Fatal(err)
		}
	}
	body, _ := json.Marshal(gates.Requirement{NotModel: "opus", MinTrust: "medium"})
	if err := ledger.Record(ctx, env.DB, tk.ID, gates.KindRequire, "gates", string(body)); err != nil {
		t.Fatal(err)
	}
	for _, review := range []bool{true, false} {
		v, err := d.view(ctx, tk, Options{Risk: "low"}, map[string]bool{"dsh+author": true}, review)
		if err != nil {
			t.Fatal(err)
		}
		for _, tc := range []struct {
			id             string
			reviewEligible bool
		}{
			{"dsh+author", false}, {"dsh+opus", false}, {"dsh+sonnet", true}, {"dsh+k2", false}, {"dsh+gpt", true},
		} {
			found := false
			for _, c := range v.Candidates {
				if c.ID != tc.id {
					continue
				}
				found = true
				want := tc.reviewEligible || !review && tc.id != "dsh+author"
				if c.Eligible != want {
					t.Errorf("review=%v %s eligible=%v，要求%v，原因%v", review, tc.id, c.Eligible, want, c.Refusals)
				}
			}
			if !found {
				t.Errorf("缺候选%s", tc.id)
			}
		}
	}
	// 即使 worker_require 没有限制，作者也在独立的排除名单里。
	if err := ledger.Record(ctx, env.DB, tk.ID, gates.KindRequire, "gates", `{}`); err != nil {
		t.Fatal(err)
	}
	w, _, err := d.chooseReview(ctx, tk, &workers.Run{Worker: "dsh+author", Host: LocalHost})
	if err != nil || w.ID == "dsh+author" {
		t.Fatalf("作者成为自己的审阅者：%s %v", w.ID, err)
	}
}

func TestReviewTokenReadOnly(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "审阅权限"}, "u1")
	for _, e := range []ledger.Event{{Kind: ledger.Enqueue}, {Kind: ledger.Start}, {Kind: ledger.ExitOK}, {Kind: ledger.GatePass, NeedReview: true}} {
		if _, err := ledger.Apply(ctx, env.DB, tk.ID, e, "runtime", ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := d.record(ctx, tk, workers.Run{N: 1, Why: workers.WhyReview, Worker: "dsh", Host: LocalHost}); err != nil {
		t.Fatal(err)
	}
	if busy, err := busyTools(ctx, env.DB); err != nil || !busy["dsh"] {
		t.Fatalf("审阅中的工具没有计入并发：%v %v", busy, err)
	}
	r := api.NewRouter(env.Log)
	r.AddAuth(authWorker(env))
	r.AddGuard("worker", workerGuard(env))
	for _, pattern := range []string{"GET /api/tasks", "POST /api/tasks/{id}/notes", "POST /api/materials", "POST /api/materials/{id}/revs"} {
		r.Handle(pattern, func(*api.Req) (any, error) { return "ok", nil })
	}
	srv := httptest.NewServer(r)
	defer srv.Close()
	c := &api.Client{Base: srv.URL, Token: workerToken("test-user-token", tk.ID, 1)}
	for _, tc := range []struct{ method, path, code string }{
		{"GET", "/api/tasks", ""}, {"POST", "/api/tasks/" + tk.ID + "/notes", "forbidden"}, {"POST", "/api/materials", "forbidden"}, {"POST", "/api/materials/m1/revs", "forbidden"},
	} {
		err := c.Do(ctx, tc.method, tc.path, nil, nil)
		var ae *api.Error
		if tc.code == "" {
			if err != nil {
				t.Fatal(err)
			}
			continue
		}
		if !errors.As(err, &ae) || ae.Code != tc.code {
			t.Fatalf("%s %s：%v", tc.method, tc.path, err)
		}
	}
	if err := recordExit(ctx, env.DB, tk.ID, workers.Run{N: 1, Worker: "dsh"}, workers.Exit{N: 1}); err != nil {
		t.Fatal(err)
	}
	if busy, err := busyTools(ctx, env.DB); err != nil || busy["dsh"] {
		t.Fatalf("退出的审阅工具仍占并发：%v %v", busy, err)
	}
	err := c.Do(ctx, "GET", "/api/tasks", nil, nil)
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Code != "unauthorized" {
		t.Fatalf("审阅退出令牌没有失效：%v", err)
	}
}
