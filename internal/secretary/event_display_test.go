package secretary

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 隔离 HTTP 实例用真实事件路由、SQLite 和 CLI；只组装注入批次，不启动模型。
func TestEventDisplayInstance(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := store.Open(filepath.Join(t.TempDir(), "events.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, x := range []struct{ id, name string }{{"a1", "Atrium 负责人"}, {"a10", "命令行和网页负责人"}} {
		if _, err := db.Exec(`INSERT INTO identities(id,kind,name,created_at) VALUES (?, 'leader', ?, 0)`, x.id, x.name); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := ledger.Add(ctx, db, ledger.NewTask{Title: "负责人呈现"}, "u1"); err != nil {
		t.Fatal(err)
	}
	rows := []events.Event{
		{Kind: events.LeaderEscalate, Task: "t1", Target: events.Secretary, Body: map[string]any{"from": "a1", "kind": "cross", "label": "需要跨部门配合", "note": "正文 a1/a10 原样"}},
		{Kind: events.Overdue, Task: "t1", Target: "a10", Body: map[string]any{"holder": "a10", "text": "待分派", "held_ms": 31 * 60000}},
		{Kind: events.WorkerDown, Target: events.Secretary, Level: events.Act, Body: map[string]any{"target": "a1+kimi@h3", "reason": "没登录", "next": "atrium workers edit --clear a1+kimi@h3"}},
	}
	for _, e := range rows {
		if err := events.Emit(ctx, db, e); err != nil {
			t.Fatal(err)
		}
	}
	router := api.NewRouter(nil)
	router.AddAuth(func(token string) (api.Actor, bool) { return api.Actor{ID: "u1", Kind: "user"}, token == "fixture" })
	env := &app.Env{DB: db}
	events.Routes(router, env)
	org.Routes(router, env)
	var nameReads atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/leaders" {
			nameReads.Add(1)
		}
		router.ServeHTTP(w, r)
	}))
	defer srv.Close()
	getenv := func(key string) string {
		switch key {
		case "ATRIUM_SERVER":
			return srv.URL
		case "ATRIUM_WORKER_TOKEN":
			return "fixture"
		}
		return ""
	}
	table := cli.NewTable("atrium", "")
	events.Commands(table)
	run := func(args ...string) string {
		t.Helper()
		var out, errors bytes.Buffer
		if code := table.Main(ctx, args, cli.Env{Stdout: &out, Stderr: &errors, Getenv: getenv}); code != 0 {
			t.Fatalf("%v: %s", args, errors.String())
		}
		t.Logf("atrium %s\n%s", strings.Join(args, " "), out.String())
		return out.String()
	}
	reset := func() {
		t.Helper()
		if _, err := db.Exec(`UPDATE events SET leased_until = NULL`); err != nil {
			t.Fatal(err)
		}
	}
	raw := run("events", "wait", "--timeout", "0", "--json")
	if nameReads.Load() != 0 {
		t.Fatal("--json 不应读取名册")
	}
	var response struct {
		Result []events.Row `json:"result"`
	}
	if err := json.Unmarshal([]byte(raw), &response); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(response.Result)
	reset()
	human := run("events", "wait", "--timeout", "0")
	if !strings.Contains(human, "Atrium 负责人（a1） 上报") || !strings.Contains(human, "收件人：秘书") || !strings.Contains(human, "a1+kimi@h3 不可用") || !strings.Contains(human, "正文 a1/a10 原样") {
		t.Fatal(human)
	}
	reset()
	reminder := run("events", "wait", "--as", "a10", "--timeout", "0")
	if !strings.Contains(reminder, "到期：待分派（已 31 分钟） · 收件人：命令行和网页负责人（a10）") {
		t.Fatal(reminder)
	}
	reset()
	reminderJSON := run("events", "wait", "--as", "a10", "--timeout", "0", "--json")
	if !strings.Contains(reminderJSON, `"target":"a10"`) || !strings.Contains(reminderJSON, `"holder":"a10"`) || strings.Contains(reminderJSON, "命令行和网页负责人") {
		t.Fatal(reminderJSON)
	}
	c := &cli.Ctx{Context: ctx, Env: cli.Env{Getenv: getenv}}
	names, err := events.ReadNames(c)
	if err != nil {
		t.Fatal(err)
	}
	batch := PlanBatch(Sent{}, response.Result, store.Now(), RemindAfter)
	prompt := Prompt(batch, store.Now(), RemindAfter, names)
	t.Logf("秘书批次文本：\n%s", prompt)
	for _, row := range response.Result {
		if !strings.Contains(prompt, events.Line(row, names)) {
			t.Fatal(prompt)
		}
	}
	after, _ := json.Marshal(response.Result)
	if !bytes.Equal(before, after) {
		t.Fatal("呈现改写了原始事件")
	}
	reset()
	got := run("events", "wait", "--timeout", "0", "--json")
	var reread struct {
		Result []events.Row `json:"result"`
	}
	if err := json.Unmarshal([]byte(got), &reread); err != nil {
		t.Fatal(err)
	}
	// 每次领取会续租；除此之外 JSON 的所有字段逐一保持。
	for i := range response.Result {
		response.Result[i].LeasedUntil = nil
		reread.Result[i].LeasedUntil = nil
	}
	firstJSON, _ := json.Marshal(response.Result)
	secondJSON, _ := json.Marshal(reread.Result)
	if !bytes.Equal(firstJSON, secondJSON) {
		t.Fatalf("除租约外 JSON 改变：%s", got)
	}
	if _, err := db.Exec(`UPDATE identities SET name = ? WHERE id = ?`, "新负责人", "a1"); err != nil {
		t.Fatal(err)
	}
	names, err = events.ReadNames(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(Prompt(batch, store.Now(), RemindAfter, names), "新负责人（a1）") {
		t.Fatal("改名未更新")
	}
	for id, want := range map[string]string{"a99": "未登记负责人（a99）", "a0": "a0", "a10x": "a10x", "gates": "gates", "worker": "worker", "u1": "u1"} {
		row := events.Row{ID: 9, Kind: events.LeaderEscalate, Target: id, Body: json.RawMessage(`{"from":"` + id + `","kind":"ask","note":"正文 a1 原样"}`)}
		got := events.Line(row, names)
		if !strings.Contains(got, want+" 问用户") || !strings.Contains(got, "收件人："+want) || !strings.Contains(got, "正文 a1 原样") {
			t.Fatal(got)
		}
	}
	for _, kind := range []string{"notify", "cross"} {
		row := events.Row{Kind: events.LeaderEscalate, Body: json.RawMessage(`{"from":"a10","kind":"` + kind + `"}`)}
		if !strings.HasPrefix(events.Summary(row, names), "命令行和网页负责人（a10）") {
			t.Fatal(events.Summary(row, names))
		}
	}
	broken := events.Row{Kind: events.LeaderEscalate, Body: json.RawMessage(`not json`)}
	if strings.Contains(events.Summary(broken, names), "Atrium 负责人") {
		t.Fatal("损坏正文误认负责人")
	}
}
