package ledger

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestPartiesReadRoute(t *testing.T) {
	f := newReadFixture(t)
	client := &api.Client{Base: f.server.URL, Token: "test-token"}
	for _, tc := range []struct{ ids, wantCode string }{
		{"", "usage"}, {"t0", "usage"}, {"t01", "usage"}, {"a1", "usage"},
		{"t1,", "usage"}, {"t1,,t2", "usage"}, {"../t1", "usage"}, {"/t1", "usage"},
		{"t1' OR 1=1", "usage"}, {"t999", "not_found"},
		{strings.Repeat("t1,", partiesBatchSize) + "t1", "usage"},
		{"t1,t2,t1", ""},
	} {
		var got map[string]Parties
		err := client.Do(f.ctx, "GET", "/api/task-parties?ids="+url.QueryEscape(tc.ids), nil, &got)
		if code(err) != tc.wantCode {
			t.Fatalf("ids=%q: %v", tc.ids, err)
		}
		if tc.wantCode == "" && (len(got) != 2 || got["t1"] != (Parties{By: "a9", Owner: "a10"}) || got["t2"].Owner != "secretary") {
			t.Fatalf("角色事实错误：%+v", got)
		}
	}
	// 路由不免认证。
	unauthorized := &api.Client{Base: f.server.URL}
	if err := unauthorized.Do(f.ctx, "GET", "/api/task-parties?ids=t1", nil, nil); code(err) != "unauthorized" {
		t.Fatalf("未认证请求被放行：%v", err)
	}
}

type partyQueries struct {
	store.Querier
	queries []string
}

func (q *partyQueries) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	q.queries = append(q.queries, query)
	return q.Querier.QueryRowContext(ctx, query, args...)
}

func (q *partyQueries) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	q.queries = append(q.queries, query)
	return q.Querier.QueryContext(ctx, query, args...)
}

func TestPartiesReadDoesNotLoadSubtrees(t *testing.T) {
	f := newReadFixture(t)
	ids := []string{"t1", "t2"}
	parent := "t2"
	for i := 0; i < 25; i++ {
		task, err := Add(f.ctx, f.db, NewTask{Title: "链节点", Parent: parent, Repo: "test/repo"}, "u1")
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, task.ID)
		parent = task.ID
	}
	q := &partyQueries{Querier: f.db}
	got, err := readParties(f.ctx, q, ids)
	if err != nil || len(got) != len(ids) || len(q.queries) != 3*len(ids) {
		t.Fatalf("每任务应只读存在性、创建角色、最新角色：tasks=%d queries=%d err=%v", len(got), len(q.queries), err)
	}
	for _, query := range q.queries {
		if strings.Contains(query, "RECURSIVE") || strings.Contains(query, "task_deps") || strings.Contains(query, "LIMIT 20") {
			t.Fatalf("角色读取不应加载子树、依赖或经历列表：%s", query)
		}
	}
}

func TestReadOwnerTextsBatches(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var calls atomic.Int32
	var omit atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/api/task-parties" {
			t.Errorf("不应读完整详情：%s", r.URL.Path)
		}
		ids, err := partyIDs(r.URL.Query().Get("ids"))
		if err != nil {
			t.Error(err)
		}
		parties := map[string]Parties{}
		if !omit.Load() {
			for _, id := range ids {
				parties[id] = Parties{Owner: "a10"}
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": parties})
	}))
	defer srv.Close()
	c := &cli.Ctx{Context: ctx, Env: cli.Env{Getenv: func(k string) string {
		switch k {
		case "ATRIUM_WORKER_TOKEN":
			return "test-token"
		case "ATRIUM_SERVER":
			return srv.URL
		}
		return ""
	}}}
	ids := make([]string, partiesBatchSize+1)
	for i := range ids {
		ids[i] = fmt.Sprintf("t%d", i+1)
	}
	names := map[string]string{"a10": "负责人"}
	out, err := readOwnerTexts(c, ids, names)
	if err != nil || calls.Load() != 2 || len(out) != len(ids) || out[ids[len(ids)-1]] != " · 处理人：负责人（a10）" {
		t.Fatalf("分批不能截断：calls=%d len=%d err=%v", calls.Load(), len(out), err)
	}
	omit.Store(true)
	if _, err := readOwnerTexts(c, ids[:1], names); err == nil {
		t.Fatal("缺失角色结果不应静默丢掉处理人")
	}
	c.JSON = true
	before := calls.Load()
	if _, err := readOwnerTexts(c, ids, names); err != nil || calls.Load() != before {
		t.Fatalf("JSON 不应增加呈现请求：%v", err)
	}
}
