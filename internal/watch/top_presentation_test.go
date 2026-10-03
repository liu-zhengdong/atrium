package watch

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
)

// 隔离数据库、真实路由与命令入口；不启动后台循环或真实执行者。
func TestTopParentPresentation(t *testing.T) {
	env, _ := setup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := env.DB.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO identities(id, kind, name, created_at) VALUES ('a10', 'leader', '命令行和网页负责人', 0)`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	parent, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "父任务归属", Org: "o1", Owner: "a1", Repo: "test/repo"}, "a1")
	if err != nil {
		t.Fatal(err)
	}
	owner := "a10"
	if _, err := ledger.Edit(ctx, env.DB, parent.ID, ledger.Patch{Owner: &owner}, "a1"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 21; i++ {
		if err := ledger.Note(ctx, env.DB, parent.ID, "a1", "旧名 a1 / a10 / a99 不是处理人事实"); err != nil {
			t.Fatal(err)
		}
	}
	var openChild string
	for _, done := range []bool{true, false} {
		child, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "子任务", Parent: parent.ID}, "u1")
		if err != nil {
			t.Fatal(err)
		}
		if !done {
			openChild = child.ID
		}
		if done {
			if _, err := ledger.Apply(ctx, env.DB, child.ID, ledger.Event{Kind: ledger.Set, To: ledger.Done}, "u1", ""); err != nil {
				t.Fatal(err)
			}
		}
	}
	r := api.NewRouter(env.Log)
	r.AddAuth(func(token string) (api.Actor, bool) {
		return api.Actor{ID: "u1", Kind: "user"}, token == "test-token"
	})
	Routes(r, env)
	ledger.Routes(r, env)
	org.Routes(r, env)
	var mu sync.Mutex
	var calls []string
	var broken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		calls = append(calls, req.URL.RequestURI())
		fault := broken
		mu.Unlock()
		if req.URL.Path == "/api/task-parties" {
			switch fault {
			case "missing":
				json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": map[string]ledger.Parties{}})
				return
			case "error":
				api.WriteJSON(w, api.Conflict("角色读取失败"), nil, r.Log)
				return
			}
		}
		r.ServeHTTP(w, req)
	}))
	defer srv.Close()
	table := cli.NewTable("atrium", "")
	Commands(table)
	run := func(args ...string) (string, int, []string) {
		t.Helper()
		mu.Lock()
		calls = nil
		mu.Unlock()
		var out, stderr bytes.Buffer
		code := table.Main(ctx, args, cli.Env{Stdout: &out, Stderr: &stderr, Getenv: func(k string) string {
			switch k {
			case "ATRIUM_SERVER":
				return srv.URL
			case "ATRIUM_WORKER_TOKEN":
				return "test-token"
			}
			return ""
		}})
		mu.Lock()
		defer mu.Unlock()
		return out.String() + stderr.String(), code, append([]string(nil), calls...)
	}
	checkHuman := func(who string) {
		t.Helper()
		out, code, requests := run("top", "--once")
		want := parent.ID + "  父任务归属  " + who + "：子任务在做（1/2 结束）"
		if code != 0 || !strings.Contains(out, want) || strings.Contains(out, "  ：子任务在做") {
			t.Fatalf("父任务呈现错误，code=%d，期望 %q：\n%s", code, want, out)
		}
		if want := []string{"/api/top", "/api/leaders", "/api/task-parties?ids=" + parent.ID}; !reflect.DeepEqual(requests, want) {
			t.Fatalf("只应补读父任务角色：%v", requests)
		}
		t.Log(out)
	}
	checkHuman("命令行和网页负责人（a10）")
	if err := env.DB.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE identities SET name = ? WHERE id = ?`, "新负责人名字", "a10")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	checkHuman("新负责人名字（a10）")
	if err := env.DB.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM identities WHERE id = ?`, "a10")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	checkHuman("未登记负责人（a10）")
	for _, fault := range []string{"missing", "error"} {
		mu.Lock()
		broken = fault
		mu.Unlock()
		out, code, _ := run("top", "--once")
		if code == 0 || strings.Contains(out, "在别人手里") {
			t.Fatalf("损坏的角色响应 %s 应报错而非输出空处理人：%d %s", fault, code, out)
		}
		t.Logf("%s 被拒绝：%s", fault, out)
	}
	// 即使角色接口故障，机器路径仍只请求 /api/top。
	out, code, requests := run("top", "--json")
	if code != 0 || !reflect.DeepEqual(requests, []string{"/api/top"}) {
		t.Fatalf("JSON 请求改变：%d %s %v", code, out, requests)
	}
	var envelope struct {
		Result View `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &envelope); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range envelope.Result.Tasks {
		if row.ID == parent.ID {
			found = true
			want := Holder{Kind: "children", Text: "子任务在做（1/2 结束）", Short: "子任务 1/2 结束"}
			if row.Holder != want || row.Overdue != 0 {
				t.Fatalf("父任务等待语义或计时改变：%+v", row)
			}
		}
	}
	if !found || strings.Contains(out, `"owner"`) || strings.Contains(out, "未登记负责人") || !strings.Contains(out, `"who":"a1"`) {
		t.Fatalf("JSON 角色或名字改变：%s", out)
	}
	if _, err := ledger.Apply(ctx, env.DB, openChild, ledger.Event{Kind: ledger.Set, To: ledger.Done}, "u1", ""); err != nil {
		t.Fatal(err)
	}
	out, code, requests = run("top", "--once")
	if code != 0 || !reflect.DeepEqual(requests, []string{"/api/top", "/api/leaders"}) || !strings.Contains(out, "未登记负责人（a10）：子任务都结束了") {
		t.Fatalf("子任务结束后应沿用原负责人等待、不补读角色：%d %s %v", code, out, requests)
	}
}

func TestRenderParentOwner(t *testing.T) {
	h := Holder{Kind: "children", Text: "子任务在做（1/2 结束）", Short: "子任务 1/2 结束"}
	for _, tc := range []struct {
		owner string
		want  string
	}{
		{"a1", "甲（a1）"},
		{"a10", strings.Repeat("长", 12) + "…（a10）"},
		{"a99", "未登记负责人（a99）"},
		{"u1", "u1"},
		{"secretary", "secretary"},
		{"", "未记录处理人"},
	} {
		t.Run(tc.owner, func(t *testing.T) {
			v := View{Names: map[string]string{"a1": "甲", "a10": strings.Repeat("长", 20) + "\n名字"}, Tasks: []TaskRow{{ID: "t1", Title: "父任务", Holder: h}}}
			before, err := json.Marshal(v)
			if err != nil {
				t.Fatal(err)
			}
			v.Owners = map[string]string{"t1": tc.owner}
			if got := Render(v); !strings.Contains(got, "t1  父任务  "+tc.want+"："+h.Text) {
				t.Fatalf("父任务角色呈现错误：%s", got)
			}
			after, err := json.Marshal(v)
			if err != nil || !bytes.Equal(before, after) || v.Tasks[0].Holder != h {
				t.Fatalf("人读投影改变 JSON 或 Holder：%s %s %v", before, after, err)
			}
		})
	}
}
