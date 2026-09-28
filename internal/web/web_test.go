package web

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestSessions(t *testing.T) {
	now := time.Unix(1000, 0)
	s := newSessions()
	s.now = func() time.Time { return now }
	code, _ := s.newLink()
	if _, ok := s.redeem("wrong"); ok {
		t.Error("错码不该换到会话")
	}
	sid, ok := s.redeem(code)
	if !ok || !s.check(sid) {
		t.Fatal("有效码应换到会话")
	}
	if _, ok := s.redeem(code); ok {
		t.Error("码只能用一次")
	}
	late, _ := s.newLink()
	now = now.Add(linkTTL)
	if _, ok := s.redeem(late); ok {
		t.Error("过期码不该换到会话")
	}
	now = now.Add(sessionTTL)
	if s.check(sid) {
		t.Error("会话过期后应失效")
	}
	if s.check("") {
		t.Error("空会话")
	}
}

func TestLocalRequest(t *testing.T) {
	cases := []struct {
		remote, host string
		ok           bool
	}{
		{"127.0.0.1:5555", "127.0.0.1:4320", true},
		{"127.0.0.1:5555", "localhost:4320", true},
		{"[::1]:5555", "[::1]:4320", true},
		{"127.0.0.1:5555", "evil.example:4320", false}, // DNS 重绑定
		{"127.0.0.1:5555", "127.0.0.1:9999", false},
		{"192.168.1.9:5555", "127.0.0.1:4320", false},
		{"garbage", "127.0.0.1:4320", false},
	}
	for _, c := range cases {
		if got := localRequest(c.remote, c.host, 4320); got != c.ok {
			t.Errorf("%s %s：得到 %v", c.remote, c.host, got)
		}
	}
}

func TestStepHolder(t *testing.T) {
	cases := []struct {
		t          ledger.Task
		step       int
		state, who string
	}{
		{ledger.Task{Status: ledger.Todo}, 0, "idle", "没派"},
		{ledger.Task{Status: ledger.Queued}, 0, "idle", "排队"},
		{ledger.Task{Status: ledger.Running, Worker: "claude+opus:high", Host: "h1"}, 1, "run", "claude · h1"},
		{ledger.Task{Status: ledger.Running}, 1, "run", "在做"},
		{ledger.Task{Status: ledger.Running, Stage: ledger.StageGate}, 2, "run", "验收中"},
		{ledger.Task{Status: ledger.Running, Stage: ledger.StageReview}, 2, "run", "审阅中"},
		{ledger.Task{Status: ledger.Running, Stage: ledger.StageMerge}, 3, "run", "合入队列"},
		{ledger.Task{Status: ledger.Running, Stage: ledger.StageMerged}, 4, "run", "等发版"},
		{ledger.Task{Status: ledger.Done, Stage: ledger.StageReleased}, 5, "done", "已上线"},
		{ledger.Task{Status: ledger.Done}, 5, "done", "完成"},
		{ledger.Task{Status: ledger.Blocked, PR: "#1"}, 2, "bad", "卡住"},
		{ledger.Task{Status: ledger.Failed, Worker: "x"}, 1, "bad", "失败"},
		{ledger.Task{Status: ledger.Cancelled}, 0, "off", "取消"},
	}
	for _, c := range cases {
		if step(c.t) != c.step || state(c.t) != c.state || who(c.t) != c.who || holder(c.t) == "" {
			t.Errorf("%s/%s：step %d state %s who %s", c.t.Status, c.t.Stage, step(c.t), state(c.t), who(c.t))
		}
	}
}

func TestTopGroup(t *testing.T) {
	parents := map[string]string{"o1": "", "o2": "o1", "o5": "o2", "o8": "o5", "o9": ""}
	for id, want := range map[string]string{"o1": "o1", "o2": "o2", "o5": "o2", "o8": "o2", "o9": "o9"} {
		if got := topGroup(parents, id); got != want {
			t.Errorf("%s：得到 %s 想要 %s", id, got, want)
		}
	}
}

func TestLogLine(t *testing.T) {
	cases := map[string]ledger.TaskEvent{
		"建立":           {Kind: "created", Actor: "u1"},
		"卡住（a1）：等签名证书": {Kind: "block", Actor: "a1", Body: `{"from":{},"to":{},"note":"等签名证书"}`},
		"备注：在跑 第 1 次":  {Kind: "note", Actor: "u1", Body: "在跑\n第 1 次"},
		"gate：PR 不存在":  {Kind: "gate", Actor: "gates", Body: "PR 不存在"},
		"交回执行者（merge）": {Kind: "bounce", Actor: "merge", Body: `{"note":""}`},
	}
	for want, e := range cases {
		if got := logLine(e); got != want {
			t.Errorf("得到 %q 想要 %q", got, want)
		}
	}
}

func TestBrowserInvocation(t *testing.T) {
	for goos, cmd := range map[string]string{"darwin": "open", "linux": "xdg-open", "windows": "rundll32"} {
		inv := browserInvocation(goos, "http://x")
		if inv.Command != cmd || inv.Args[len(inv.Args)-1] != "http://x" {
			t.Errorf("%s：%+v", goos, inv)
		}
	}
}

// 整条路径：取链接（要用户令牌）→ 打开链接换 cookie → 读接口；不带 cookie、错 Host、码用两次都拒绝。
func TestRoutes(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	root, err := org.Add(ctx, db, org.NewDept{Name: "组织"})
	if err != nil {
		t.Fatal(err)
	}
	sub, _ := org.Add(ctx, db, org.NewDept{Name: "运行时", Parent: root.ID})
	org.AddPoint(ctx, db, root.ID, org.NewPoint{Text: "简洁优先"}, "u1")
	task, _ := ledger.Add(ctx, db, ledger.NewTask{Title: "卡住的活", Org: sub.ID}, "u1")
	if _, err := ledger.Apply(ctx, db, task.ID, ledger.Event{Kind: ledger.Block}, "a1", "等你拍板"); err != nil {
		t.Fatal(err)
	}

	r := api.NewRouter(slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.AddAuth(func(tok string) (api.Actor, bool) { return api.Actor{ID: "u1", Kind: "user"}, tok == "secret" })
	srv := httptest.NewServer(r)
	defer srv.Close()
	port, _ := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	m := Module()
	m.Routes(r, &app.Env{DB: db, Port: port, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})

	client := &api.Client{Base: srv.URL, Token: "secret"}
	var link Link
	if err := client.Do(ctx, "POST", "/api/web/link", nil, &link); err != nil {
		t.Fatal(err)
	}
	if (&api.Client{Base: srv.URL, Token: "bad"}).Do(ctx, "POST", "/api/web/link", nil, nil) == nil {
		t.Error("错令牌不该拿到链接")
	}
	u, _ := url.Parse(link.URL)
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	get := func(path, cookie, host string) *http.Response {
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		if cookie != "" {
			req.Header.Set("Cookie", cookieName+"="+cookie)
		}
		if host != "" {
			req.Host = host
		}
		res, err := noRedirect.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	res := get("/login?"+u.RawQuery, "", "")
	var sid string
	for _, c := range res.Cookies() {
		if c.Name == cookieName && c.HttpOnly && c.SameSite == http.SameSiteStrictMode {
			sid = c.Value
		}
	}
	if res.StatusCode != 303 || sid == "" {
		t.Fatalf("登录：%d cookie %q", res.StatusCode, sid)
	}
	if res := get("/login?"+u.RawQuery, "", ""); res.Header.Get("Location") != "/#expired" {
		t.Error("码第二次用应转到过期页")
	}
	if res := get("/ui/api/today", "", ""); res.StatusCode != 401 {
		t.Errorf("不带 cookie 应 401，得到 %d", res.StatusCode)
	}
	if res := get("/ui/api/today", sid, "evil.example:"+strconv.Itoa(port)); res.StatusCode != 403 {
		t.Errorf("外来 Host 应 403，得到 %d", res.StatusCode)
	}
	if res := get("/ui/api/dept/..", sid, ""); res.StatusCode == 200 {
		t.Error("路径穿越不该 200")
	}
	read := func(path string, out any) {
		res := get("/ui/api/"+path, sid, "")
		defer res.Body.Close()
		var env struct {
			OK     bool            `json:"ok"`
			Result json.RawMessage `json:"result"`
		}
		if err := json.NewDecoder(res.Body).Decode(&env); err != nil || !env.OK {
			t.Fatalf("%s：%d %v", path, res.StatusCode, err)
		}
		json.Unmarshal(env.Result, out)
	}
	var today Today
	read("today", &today)
	if len(today.Asks) != 1 || today.Asks[0].ID != task.ID || today.Asks[0].Sub != "等你拍板" || today.Asks[0].DeptName != "运行时" {
		t.Errorf("今天：%+v", today.Asks)
	}
	var page DeptPage
	read("dept/"+sub.ID, &page)
	if len(page.Tasks) != 1 || page.Tasks[0].State != "bad" || len(page.Inherited) != 1 || !reflect.DeepEqual(page.Path, []Pair{{root.ID, "组织"}}) {
		t.Errorf("部门：%+v", page)
	}
	var nav Nav
	read("nav", &nav)
	if len(nav.Depts) != 2 || nav.Depts[0].Stuck != 1 || nav.Asks != 1 {
		t.Errorf("侧栏：%+v", nav)
	}
	var detail TaskDetail
	read("task/"+task.ID, &detail)
	if detail.State != "bad" || len(detail.Log) != 2 {
		t.Errorf("任务：%+v", detail)
	}
	var legion Legion
	read("legion", &legion)
	if legion.Accounts == nil || legion.Hosts == nil {
		t.Error("空的额度与机器应是空数组，不是 null")
	}
	if res := get("/", "", ""); res.StatusCode != 200 || !strings.Contains(res.Header.Get("Content-Security-Policy"), "script-src") && !strings.Contains(res.Header.Get("Content-Security-Policy"), "default-src 'self'") {
		t.Errorf("首页：%d", res.StatusCode)
	}
}
