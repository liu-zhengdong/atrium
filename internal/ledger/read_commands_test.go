package ledger

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

type readFixture struct {
	db     *store.DB
	ctx    context.Context
	table  *cli.Table
	server *httptest.Server
	mu     sync.Mutex
	calls  []string
	fail   string
}

func newReadFixture(t *testing.T) *readFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	f := &readFixture{db: openDB(t), ctx: ctx, table: cli.NewTable("atrium", "")}
	err := f.db.Tx(ctx, func(tx *sql.Tx) error {
		for id, name := range map[string]string{"a1": "Atrium 负责人", "a9": "派活和验收负责人", "a10": "命令行和网页负责人"} {
			if _, err := tx.ExecContext(ctx, `INSERT INTO identities(id,kind,name,created_at) VALUES (?, 'leader', ?, 0)`, id, name); err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO departments(id,name,created_at,updated_at) VALUES ('o1','测试部门',0,0)`)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	root, err := Add(ctx, f.db, NewTask{Title: "负责人名字与短号呈现", Owner: "a1", Org: "o1", Repo: "test/repo"}, "a9")
	if err != nil {
		t.Fatal(err)
	}
	owner := "a10"
	if _, err := Edit(ctx, f.db, root.ID, Patch{Owner: &owner}, "a9"); err != nil {
		t.Fatal(err)
	}
	// 处理人改动不在最近 20 条经历中，列表仍必须使用 PartiesOf 的当前事实。
	for i := 0; i < 21; i++ {
		if err := Note(ctx, f.db, root.ID, "gates", fmt.Sprintf("正文 a1 / a10 / a99 %d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := Record(ctx, f.db, root.ID, "escalated", "a9", `{"from":"a1","label":"需要跨部门配合","note":"a10 原文"}`); err != nil {
		t.Fatal(err)
	}
	if err := Record(ctx, f.db, root.ID, "escalated", "a10", "上报 a1（需要跨部门配合）：a9 原文"); err != nil {
		t.Fatal(err)
	}
	if _, err := Add(ctx, f.db, NewTask{Title: "子任务", Parent: root.ID, Owner: "secretary", Repo: "test/repo"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if _, err := Add(ctx, f.db, NewTask{Title: "草稿", Org: "o1", Draft: true, Owner: "a1"}, "a9"); err != nil {
		t.Fatal(err)
	}
	r := api.NewRouter(slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.AddAuth(func(token string) (api.Actor, bool) { return api.Actor{ID: "u1", Kind: "user"}, token == "test-token" })
	env := &app.Env{DB: f.db}
	Routes(r, env)
	org.Routes(r, env)
	r.Handle("GET /api/tasks/{id}/holder", func(q *api.Req) (any, error) {
		return map[string]any{"holder": map[string]string{"text": "a10：待分派", "next": "atrium task tree t1"}}, nil
	})
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		f.mu.Lock()
		f.calls = append(f.calls, req.URL.RequestURI())
		fail := f.fail == req.URL.Path
		f.mu.Unlock()
		if fail {
			api.WriteJSON(w, api.Unavailable("测试读取失败"), nil, r.Log)
			return
		}
		r.ServeHTTP(w, req)
	}))
	t.Cleanup(f.server.Close)
	Commands(f.table)
	return f
}

func (f *readFixture) run(t *testing.T, args ...string) (string, int) {
	t.Helper()
	var out, stderr bytes.Buffer
	code := f.table.Main(f.ctx, args, cli.Env{Stdout: &out, Stderr: &stderr, Getenv: func(k string) string {
		switch k {
		case "ATRIUM_WORKER":
			return "1"
		case "ATRIUM_WORKER_TOKEN":
			return "test-token"
		case "ATRIUM_SERVER":
			return f.server.URL
		}
		return ""
	}})
	return out.String() + stderr.String(), code
}

func (f *readFixture) requests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	calls := f.calls
	f.calls = nil
	return calls
}

func requireText(t *testing.T, got string, wants ...string) {
	t.Helper()
	for _, want := range wants {
		if !strings.Contains(got, want) {
			t.Errorf("缺少 %q：\n%s", want, got)
		}
	}
}

func TestReadCommandsHuman(t *testing.T) {
	f := newReadFixture(t)
	for _, tc := range []struct {
		args  []string
		wants []string
		calls []string
	}{
		{[]string{"task", "ls"}, []string{"负责人名字与短号呈现 · 处理人：命令行和网页负责人（a10）", "子任务 · 处理人：secretary", "另有草稿 1 件", "下一步：atrium task show t2"}, []string{"/api/tasks?", "/api/leaders", "/api/task-parties?ids=t2%2Ct1"}},
		{[]string{"task", "ls", "--status", "draft", "--org", "o1", "--top", "--limit", "1"}, []string{"t3  draft  normal  草稿 · 处理人：Atrium 负责人（a1）"}, []string{"/api/tasks?limit=1&org=o1&status=draft&top=1", "/api/leaders", "/api/task-parties?ids=t3"}},
		{[]string{"task", "tree", "t1"}, []string{"t1  todo  负责人名字与短号呈现（0/1 完成） · 处理人：命令行和网页负责人（a10）", "  t2  todo  可派  子任务 · 处理人：secretary", "下一步：atrium task run t2"}, []string{"/api/tasks/t1/tree", "/api/leaders", "/api/task-parties?ids=t1%2Ct2"}},
		{[]string{"task", "show", "t1"}, []string{"任务分派人：派活和验收负责人（a9）", "处理人：命令行和网页负责人（a10）", "上报人：Atrium 负责人（a1） · 需要跨部门配合", "上报人：命令行和网页负责人（a10）", "派活和验收负责人（a9）  escalated  {\"from\":\"a1\"", "命令行和网页负责人（a10）  escalated  上报 a1（需要跨部门配合）：a9 原文", "gates  note  正文 a1 / a10 / a99", "下一步：atrium task tree t1"}, []string{"/api/tasks/t1", "/api/tasks/t1/holder", "/api/leaders"}},
	} {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			got, code := f.run(t, tc.args...)
			if code != 0 {
				t.Fatal(got)
			}
			requireText(t, got, tc.wants...)
			if tc.args[1] == "show" {
				header, _, _ := strings.Cut(got, "经历：")
				if strings.Contains(header, "上报人：") {
					t.Fatal("历史上报人不应平铺成当前属性")
				}
				requireText(t, got, "a10 原文\"}\n    上报人：Atrium 负责人（a1） · 需要跨部门配合", "上报 a1（需要跨部门配合）：a9 原文\n    上报人：命令行和网页负责人（a10）")
			}
			if tc.args[1] != "show" && (strings.Contains(got, "任务分派人：") || strings.Contains(got, "上报人：")) {
				t.Fatalf("列表多加了角色列：%s", got)
			}
			if calls := f.requests(); !reflect.DeepEqual(calls, tc.calls) {
				t.Errorf("requests=%v, want=%v", calls, tc.calls)
			}
		})
	}
}

func TestReadCommandsRenameAndDelete(t *testing.T) {
	f := newReadFixture(t)
	for _, name := range []string{"长名\n含（括号）<&>\"", ""} {
		err := f.db.Tx(f.ctx, func(tx *sql.Tx) error {
			if name == "" {
				_, err := tx.ExecContext(f.ctx, `DELETE FROM identities WHERE id = ?`, "a10")
				return err
			}
			_, err := tx.ExecContext(f.ctx, `UPDATE identities SET name = ? WHERE id = ?`, name, "a10")
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		want := name + "（a10）"
		if name == "" {
			want = "未登记负责人（a10）"
		}
		for _, args := range [][]string{{"task", "ls"}, {"task", "tree", "t1"}, {"task", "show", "t1"}} {
			got, code := f.run(t, args...)
			if code != 0 {
				t.Fatal(got)
			}
			requireText(t, got, "处理人："+want)
		}
		p, err := PartiesOf(f.ctx, f.db, "t1")
		if err != nil || p != (Parties{By: "a9", Owner: "a10"}) {
			t.Fatalf("PartiesOf 被呈现改写：%+v %v", p, err)
		}
	}
}

func TestReadCommandsJSON(t *testing.T) {
	f := newReadFixture(t)
	client := &api.Client{Base: f.server.URL, Token: "test-token"}
	for _, tc := range []struct {
		args []string
		path string
		next string
	}{
		{[]string{"task", "ls", "--json"}, "/api/tasks?", "atrium task show t2"},
		{[]string{"task", "tree", "t1", "--json"}, "/api/tasks/t1/tree", "atrium task run t2"},
		{[]string{"task", "tree", "--json"}, "/api/tree", "atrium task run t2"},
		{[]string{"task", "show", "t1", "--json"}, "/api/tasks/t1", "atrium task tree t1"},
	} {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			var want any
			if err := client.Do(f.ctx, "GET", tc.path, nil, &want); err != nil {
				t.Fatal(err)
			}
			f.requests()
			if tc.args[1] == "show" {
				want.(map[string]any)["holder"] = "a10：待分派"
			}
			got, code := f.run(t, tc.args...)
			var out struct {
				OK     bool   `json:"ok"`
				Result any    `json:"result"`
				Next   string `json:"next"`
			}
			if code != 0 || json.Unmarshal([]byte(got), &out) != nil || !out.OK || out.Next != tc.next || !reflect.DeepEqual(out.Result, want) {
				t.Fatalf("机器输出变化：%s\nwant=%+v", got, want)
			}
			wantCalls := []string{tc.path}
			if tc.args[1] == "show" {
				wantCalls = append(wantCalls, tc.path+"/holder")
			}
			if calls := f.requests(); !reflect.DeepEqual(calls, wantCalls) {
				t.Fatalf("JSON 增加了呈现请求：%v", calls)
			}
		})
	}
}

func TestReadCommandsFailuresAndEmpty(t *testing.T) {
	f := newReadFixture(t)
	for _, path := range []string{"/api/leaders", "/api/task-parties"} {
		f.mu.Lock()
		f.fail = path
		f.mu.Unlock()
		for _, args := range [][]string{{"task", "ls"}, {"task", "tree", "t1"}} {
			got, code := f.run(t, args...)
			if code == 0 || !strings.Contains(got, "测试读取失败") || strings.Contains(got, "处理人：") {
				t.Fatalf("读取失败应报错，不伪造未登记或部分输出：%s", got)
			}
		}
	}
	f.requests()
	got, code := f.run(t, "task", "ls", "--status", "done")
	if code != 0 || !strings.Contains(got, "没有任务") || len(f.requests()) != 1 {
		t.Fatalf("空列表不应读取呈现资料：%s", got)
	}
	f.requests()
	got, code = f.run(t, "task", "ls", "--parent", "t999")
	if code != 0 || !strings.Contains(got, "没有任务") || len(f.requests()) != 1 {
		t.Fatalf("空过滤结果：%s", got)
	}
}
