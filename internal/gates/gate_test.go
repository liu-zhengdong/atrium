package gates_test

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/gates/fakegh"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
)

type env struct {
	t   *testing.T
	ctx context.Context
	db  *store.DB
	gh  *fakegh.GH
	g   *gates.Gate
}

func setup(t *testing.T) *env {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	gh := fakegh.New(t, nil)
	e := &env{t: t, ctx: context.Background(), db: db, gh: gh,
		g: &gates.Gate{DB: db, Pause: &pause.Store{DB: db}, R: gh, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}}
	for name, spec := range map[string]string{
		"claude":  "tool: claude\nmodel: opus\ntrust: medium\nchecks: [finished, pr_exists, claims_verified]\n",
		"kimi":    "tool: kimi\nmodel: k2\ntrust: low\n",
		"codex":   "tool: codex\nmodel: gpt\ntrust: high\n",
		"claude2": "tool: claude\nmodel: sonnet\ntrust: high\n",
	} {
		if _, err := db.ExecContext(e.ctx, `INSERT INTO worker_profiles (name, spec, updated_by, updated_at) VALUES (?, ?, 'u1', 0)`, name, spec); err != nil {
			t.Fatal(err)
		}
	}
	return e
}

// running 造一件执行者刚正常退出、停在关卡的任务。
func (e *env) delivered(title, worker, dir string) ledger.Task {
	e.t.Helper()
	t, err := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: title, Repo: "o/r"}, "u1")
	if err != nil {
		e.t.Fatal(err)
	}
	e.start(t.ID, worker)
	if dir != "" {
		if err := ledger.Record(e.ctx, e.db, t.ID, gates.KindWorktree, "dispatch", `{"dir":"`+filepath.ToSlash(dir)+`"}`); err != nil {
			e.t.Fatal(err)
		}
	}
	return e.exit(t.ID)
}

func (e *env) start(id, worker string) {
	e.t.Helper()
	if _, err := ledger.Apply(e.ctx, e.db, id, ledger.Event{Kind: ledger.Enqueue}, "u1", ""); err != nil {
		e.t.Fatal(err)
	}
	e.db.ExecContext(e.ctx, `DELETE FROM queue WHERE task = ?`, id) // 模拟 dispatch 取走
	if _, err := ledger.Apply(e.ctx, e.db, id, ledger.Event{Kind: ledger.Start}, "dispatch", ""); err != nil {
		e.t.Fatal(err)
	}
	if err := ledger.SetFacts(e.ctx, e.db, id, ledger.Facts{Worker: &worker}, "dispatch"); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) exit(id string) ledger.Task {
	e.t.Helper()
	t, err := ledger.Apply(e.ctx, e.db, id, ledger.Event{Kind: ledger.ExitOK}, "dispatch", "")
	if err != nil {
		e.t.Fatal(err)
	}
	return t
}

func (e *env) sweep() {
	e.t.Helper()
	if err := e.g.Sweep(e.ctx); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) get(id string) ledger.Task {
	e.t.Helper()
	t, err := ledger.Get(e.ctx, e.db, id)
	if err != nil {
		e.t.Fatal(err)
	}
	return t
}

func (e *env) queued(id string) bool {
	var n int
	e.db.QueryRowContext(e.ctx, `SELECT count(*) FROM queue WHERE task = ?`, id).Scan(&n)
	return n == 1
}

func (e *env) lastNote(id string) string {
	h, err := ledger.History(e.ctx, e.db, id, 50)
	if err != nil {
		e.t.Fatal(err)
	}
	return h[len(h)-1].Body
}

const goodBody = "## 做了什么\nx\n## 端到端验证\n$ atrium task ls\nok\n"

func TestGatePassToMergeQueue(t *testing.T) {
	e := setup(t)
	dir := filepath.Join(t.TempDir(), "wt")
	e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
	e.gh.Open("t1-work", goodBody)
	task := e.delivered("做事", "claude", dir)
	e.sweep()
	got := e.get(task.ID)
	if got.Status != ledger.Running || got.Stage != ledger.StageMerge || !strings.HasSuffix(got.PR, "/pull/1") {
		t.Fatalf("应进合入队列：%+v", got)
	}
}

func TestGateBounces(t *testing.T) {
	cases := []struct {
		name string
		prep func(e *env, dir string)
		want string
	}{
		{"没开 PR", func(e *env, dir string) {}, "pr_exists"},
		{"没写端到端验证", func(e *env, dir string) { e.gh.Open("t1-work", "## 做了什么\nx\n") }, "claims_verified"},
		{"本地有没推送的提交", func(e *env, dir string) {
			e.gh.Open("t1-work", goodBody)
			e.gh.Write(dir, "b.go", "package a\n")
			e.gh.Must(dir, "add", "-A")
			e.gh.Must(dir, "commit", "--quiet", "-m", "more")
		}, "没推送"},
		{"有未提交文件", func(e *env, dir string) {
			e.gh.Open("t1-work", goodBody)
			e.gh.Write(dir, "c.go", "package a\n")
		}, "未提交"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := setup(t)
			dir := filepath.Join(t.TempDir(), "wt")
			e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
			c.prep(e, dir)
			task := e.delivered("做事", "claude", dir)
			e.sweep()
			got := e.get(task.ID)
			if got.Status != ledger.Queued || !e.queued(task.ID) {
				t.Fatalf("应交回并进派活队列：%+v", got)
			}
			if note := e.lastNote(task.ID); !strings.Contains(note, c.want) {
				t.Fatalf("交回原因应含 %q：%s", c.want, note)
			}
		})
	}
}

func TestGateNoWorktreeBlocks(t *testing.T) {
	e := setup(t)
	task := e.delivered("做事", "claude", "")
	e.sweep()
	if got := e.get(task.ID); got.Status != ledger.Blocked || !strings.Contains(e.lastNote(task.ID), "没有工作树登记") {
		t.Fatalf("没有工作树登记应受阻：%+v %s", got, e.lastNote(task.ID))
	}
}

func TestGateNoRepoFinishes(t *testing.T) {
	e := setup(t)
	task, _ := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "调研"}, "u1")
	e.start(task.ID, "kimi")
	e.exit(task.ID)
	e.sweep()
	if got := e.get(task.ID); got.Status != ledger.Done {
		t.Fatalf("没有仓库的任务过关卡即完成：%+v", got)
	}
}

// 低信任执行者：关卡过后建审阅任务；审阅者结论决定进合入队列还是交回。
func TestReview(t *testing.T) {
	cases := []struct {
		name     string
		reviewer string
		result   string
		status   ledger.Status
		stage    ledger.Stage
	}{
		{"通过", "codex", "看过了\n审阅结论：通过", ledger.Running, ledger.StageMerge},
		{"打回", "codex", "a.go:1 缺测试\n审阅结论：打回", ledger.Queued, ""},
		{"没写结论", "codex", "看过了", ledger.Blocked, ledger.StageReview},
		{"审阅者与原执行者同工具不算", "claude2", "审阅结论：通过", ledger.Blocked, ledger.StageReview},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := setup(t)
			dir := filepath.Join(t.TempDir(), "wt")
			e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
			e.gh.Open("t1-work", goodBody)
			if _, err := e.db.ExecContext(e.ctx, `UPDATE worker_profiles SET spec = 'tool: claude
model: haiku
trust: low
' WHERE name = 'kimi'`); err != nil {
				t.Fatal(err)
			}
			task := e.delivered("做事", "kimi", dir)
			e.sweep()
			if got := e.get(task.ID); got.Stage != ledger.StageReview {
				t.Fatalf("低信任应先审阅：%+v", got)
			}
			ref, ok, _ := gates.Last(e.ctx, e.db, task.ID, gates.KindReviewer)
			rt := e.get(ref)
			if !ok || rt.Status != ledger.Queued || rt.Parent != task.ID || !e.queued(rt.ID) || !strings.Contains(rt.Detail, "审阅结论：通过") {
				t.Fatalf("审阅任务不对：%+v", rt)
			}
			req, _, _ := gates.Last(e.ctx, e.db, rt.ID, gates.KindRequire)
			if !strings.Contains(req, `"not_tool":"claude"`) || !strings.Contains(req, `"min_trust":"medium"`) {
				t.Fatalf("审阅者要求不对：%s", req)
			}
			e.sweep() // 审阅任务还在排队：原任务不动，也不重复建
			if again, _, _ := gates.Last(e.ctx, e.db, task.ID, gates.KindReviewer); again != ref {
				t.Fatalf("重复建了审阅任务：%s", again)
			}
			e.db.ExecContext(e.ctx, `DELETE FROM queue WHERE task = ?`, rt.ID)
			ledger.Apply(e.ctx, e.db, rt.ID, ledger.Event{Kind: ledger.Start}, "dispatch", "")
			w := c.reviewer
			ledger.SetFacts(e.ctx, e.db, rt.ID, ledger.Facts{Worker: &w}, "dispatch")
			ledger.Record(e.ctx, e.db, rt.ID, gates.KindResult, "dispatch", c.result)
			e.exit(rt.ID)
			e.sweep()
			if got := e.get(rt.ID); got.Status != ledger.Done {
				t.Fatalf("审阅任务应完成：%+v", got)
			}
			if got := e.get(task.ID); got.Status != c.status || got.Stage != c.stage {
				t.Fatalf("原任务 %s/%s，期望 %s/%s：%s", got.Status, got.Stage, c.status, c.stage, e.lastNote(task.ID))
			}
		})
	}
}

func TestHighRiskReviewed(t *testing.T) {
	e := setup(t)
	dir := filepath.Join(t.TempDir(), "wt")
	e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
	e.gh.Open("t1-work", goodBody)
	task, _ := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "做事", Repo: "o/r"}, "u1")
	e.start(task.ID, "codex")
	ledger.Record(e.ctx, e.db, task.ID, gates.KindWorktree, "dispatch", `{"dir":"`+filepath.ToSlash(dir)+`"}`)
	ledger.Record(e.ctx, e.db, task.ID, gates.KindRisk, "u1", "high")
	e.exit(task.ID)
	e.sweep()
	if got := e.get(task.ID); got.Stage != ledger.StageReview {
		t.Fatalf("高风险应先审阅：%+v", got)
	}
}

func TestPausedSkipped(t *testing.T) {
	e := setup(t)
	task := e.delivered("做事", "claude", "")
	(&pause.Store{DB: e.db}).Set(e.ctx, pause.All, "u1")
	e.sweep()
	if got := e.get(task.ID); got.Stage != ledger.StageGate || got.Status != ledger.Running {
		t.Fatalf("暂停时不动：%+v", got)
	}
}
