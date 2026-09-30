package gates_test

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/gates/fakegh"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
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
	// 档案按 workers 的三层（harness/models/combos）写；任务上记的是执行者标识「工具+模型」。
	for name, spec := range map[string]string{
		"combos/claude+opus":   "---\ntrust: medium\nchecks: [finished, pr_exists, claims_verified]\n---\n",
		"combos/kimi+k2":       "---\ntrust: low\n---\n",
		"combos/codex+gpt":     "---\ntrust: high\n---\n",
		"combos/claude+sonnet": "---\ntrust: high\n---\n",
		"combos/claude+haiku":  "---\ntrust: low\n---\n",
	} {
		if _, err := db.ExecContext(e.ctx, `INSERT INTO worker_profiles (name, spec, updated_by, updated_at) VALUES (?, ?, 'u1', 0)`, name, spec); err != nil {
			t.Fatal(err)
		}
	}
	gates.Enqueue = func(ctx context.Context, id, by string) error { // 代替 dispatch.Enqueue
		_, err := ledger.Apply(ctx, db, id, ledger.Event{Kind: ledger.Enqueue}, by, "")
		return err
	}
	return e
}

// running 造一件执行者刚正常退出、停在交付检查的任务。
func (e *env) delivered(title, worker, dir string) ledger.Task {
	e.t.Helper()
	t, err := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: title, Repo: "o/r"}, "u1")
	if err != nil {
		e.t.Fatal(err)
	}
	e.start(t.ID, worker)
	if dir != "" {
		if err := ledger.Record(e.ctx, e.db, t.ID, gates.KindWorktree, "dispatch", `{"host":"h1","dir":"`+filepath.ToSlash(dir)+`"}`); err != nil {
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

// exit 模拟执行者正常退出：dispatch 先记它最后的回复（测试没另记的按「交付结论：完成」），再转交付检查。
func (e *env) exit(id string) ledger.Task {
	e.t.Helper()
	if e.count(id, gates.KindResult) == 0 {
		ledger.Record(e.ctx, e.db, id, gates.KindResult, "dispatch", "做完了\n交付结论：完成")
	}
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

func (e *env) count(id, kind string) int {
	var n int
	e.db.QueryRowContext(e.ctx, `SELECT count(*) FROM task_events WHERE task = ? AND kind = ?`, id, kind).Scan(&n)
	return n
}

const goodBody = "## 做了什么\nx\n## 端到端验证\n$ atrium task ls\nok\n"

func TestGatePassToMergeQueue(t *testing.T) {
	e := setup(t)
	dir := filepath.Join(t.TempDir(), "wt")
	e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
	e.gh.Open("t1-work", goodBody)
	task := e.delivered("做事", "claude+opus", dir)
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
			task := e.delivered("做事", "claude+opus", dir)
			e.sweep()
			got := e.get(task.ID)
			if got.Status != ledger.Queued || e.queued(task.ID) {
				t.Fatalf("应交回（queued，dispatch 沿用上次的执行者，不写队列行）：%+v", got)
			}
			if note := e.lastNote(task.ID); !strings.Contains(note, c.want) {
				t.Fatalf("交回原因应含 %q：%s", c.want, note)
			}
		})
	}
}

// 有仓库但工作树相对基线没有改动（装工具、调研这类不改代码的活）：不要 PR，按没有仓库交，过交付检查即完成；
// 只有未提交的文件算改动，照样按 PR 交回。
func TestGateNoChanges(t *testing.T) {
	cases := []struct {
		name  string
		local bool
		dirty bool
		want  ledger.Status
		note  string
	}{
		{"GitHub 仓库没有改动", false, false, ledger.Done, "没有改动"},
		{"GitHub 仓库只有未提交文件", false, true, ledger.Queued, "未提交"},
		{"本机仓库没有改动", true, false, ledger.Done, "没有改动"},
		{"本机仓库只有未提交文件", true, true, ledger.Queued, "未提交"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := setup(t)
			var task ledger.Task
			var dir string
			if c.local {
				task, dir = e.localTask("", e.localRepo(), nil, false)
			} else {
				dir = filepath.Join(t.TempDir(), "wt")
				e.gh.Must(filepath.Dir(dir), "clone", "--quiet", e.gh.Bare, dir)
				e.gh.Must(dir, "checkout", "--quiet", "-b", "t1-work")
				task = e.delivered("在 h3 装工具", "claude+opus", dir)
			}
			if c.dirty {
				e.gh.Write(dir, "c.go", "package a\n")
			}
			e.sweep()
			if got := e.get(task.ID); got.Status != c.want || !strings.Contains(e.lastNote(task.ID), c.note) {
				t.Fatalf("状态 %s，期望 %s 且经历含 %q：%s", got.Status, c.want, c.note, e.lastNote(task.ID))
			}
		})
	}
}

// 没有改动可查的交付（message、dir）按执行者这一轮最后一行的交付结论判：完成才完成；没做成、没写转受阻交处理人，
// 不交回重跑；上一轮的回复不算这一轮的（t486 没做成、t463 停下等决定都曾被判成 done）。
func TestGateEnding(t *testing.T) {
	cases := []struct {
		name  string
		repo  bool // 有仓库但工作树没改动；否则没有仓库
		reply string
		stale bool // 回复记在这一轮拉起之前
		want  ledger.Status
		note  string
	}{
		{"没改动、完成", true, "装好了\n交付结论：完成", false, ledger.Done, "没有改动"},
		{"没改动、没做成", true, "h3 上读不到设计稿\n交付结论：没做成", false, ledger.Blocked, "没做成（h3 上读不到设计稿）"},
		{"没仓库、停下等决定", false, "两个方案等负责人定\n交付结论：没做成", false, ledger.Blocked, "没做成（两个方案等负责人定）"},
		{"没仓库、没写结论", false, "没做成，没改代码也没开 PR", false, ledger.Blocked, "没写「交付结论"},
		{"没仓库、空回复", false, "", false, ledger.Blocked, "这一轮没记到执行者的回复"},
		{"上一轮的完成不算", false, "交付结论：完成", true, ledger.Blocked, "这一轮没记到执行者的回复"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := setup(t)
			task, _ := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "调研"}, "u1")
			dir := t.TempDir()
			if c.repo {
				task, _ = ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "在 h3 装工具", Repo: "o/r"}, "u1")
				dir = filepath.Join(t.TempDir(), "wt")
				e.gh.Must(filepath.Dir(dir), "clone", "--quiet", e.gh.Bare, dir)
				e.gh.Must(dir, "checkout", "--quiet", "-b", "t1-work")
			}
			e.start(task.ID, "claude+opus")
			ledger.Record(e.ctx, e.db, task.ID, gates.KindWorktree, "dispatch", `{"host":"h1","dir":"`+filepath.ToSlash(dir)+`"}`)
			if c.stale {
				ledger.Record(e.ctx, e.db, task.ID, gates.KindResult, "dispatch", c.reply)
				ledger.Record(e.ctx, e.db, task.ID, workers.RunKind, "dispatch", "{}")
			} else {
				ledger.Record(e.ctx, e.db, task.ID, workers.RunKind, "dispatch", "{}")
				ledger.Record(e.ctx, e.db, task.ID, gates.KindResult, "dispatch", c.reply)
			}
			e.exit(task.ID)
			e.sweep()
			if got := e.get(task.ID); got.Status != c.want || !strings.Contains(e.lastNote(task.ID), c.note) {
				t.Fatalf("状态 %s，期望 %s 且经历含 %q：%s", got.Status, c.want, c.note, e.lastNote(task.ID))
			}
			if e.queued(task.ID) {
				t.Fatal("没做成不该交回重跑")
			}
			if c.reply == "" || c.stale {
				if note := e.lastNote(task.ID); !strings.Contains(note, "这一轮没记到执行者的回复（atrium task log "+task.ID+" 看原始输出）") {
					t.Fatalf("空回复应提示查看本任务原始输出：%s", note)
				}
			}
		})
	}
}

func TestGateNoWorktreeBlocks(t *testing.T) {
	e := setup(t)
	task := e.delivered("做事", "claude+opus", "")
	e.sweep()
	if got := e.get(task.ID); got.Status != ledger.Blocked || !strings.Contains(e.lastNote(task.ID), "没有工作树登记") {
		t.Fatalf("没有工作树登记应受阻：%+v %s", got, e.lastNote(task.ID))
	}
}

// 没有仓库的任务（调研）：过交付检查即完成；工作目录根有 choice.json 就登记成选项单，不合法交回执行者改。
func TestGateNoRepo(t *testing.T) {
	good := `{"title":"下一步","options":[` + strings.Repeat(`{"title":"A","gain":"g","why_now":"w","cost":"c","if_not":"i","evidence":"e"},`, 2) +
		`{"title":"B","gain":"g","why_now":"w","cost":"c","if_not":"i","evidence":"e"}],"recommend":[2],"reason":"r"}`
	cases := []struct {
		name, choice string
		want         ledger.Status
		choices      int
	}{
		{"没有 choice.json", "", ledger.Done, 0},
		{"登记选项单", good, ledger.Done, 1},
		{"choice.json 不合法", `{"title":"x","extra":1}`, ledger.Queued, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := setup(t)
			d, err := org.Add(e.ctx, e.db, org.NewDept{Name: "调研部"})
			if err != nil {
				t.Fatal(err)
			}
			task, _ := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "调研", Org: d.ID}, "u1")
			e.start(task.ID, "kimi+k2")
			dir := t.TempDir()
			if c.choice != "" {
				os.WriteFile(filepath.Join(dir, "choice.json"), []byte(c.choice), 0o600)
			}
			ledger.Record(e.ctx, e.db, task.ID, gates.KindWorktree, "dispatch", `{"host":"h1","dir":"`+filepath.ToSlash(dir)+`"}`)
			e.exit(task.ID)
			e.sweep()
			if got := e.get(task.ID); got.Status != c.want {
				t.Fatalf("状态 %s，期望 %s：%s", got.Status, c.want, e.lastNote(task.ID))
			}
			var n int
			e.db.QueryRowContext(e.ctx, `SELECT count(*) FROM choices WHERE task = ?`, task.ID).Scan(&n)
			if n != c.choices {
				t.Fatalf("选项单 %d 份，期望 %d", n, c.choices)
			}
		})
	}
}

// 低信任执行者：交付检查过后建审阅任务；审阅者结论决定进合入队列还是交回。
func TestReview(t *testing.T) {
	cases := []struct {
		name     string
		reviewer string
		result   string
		status   ledger.Status
		stage    ledger.Stage
	}{
		{"通过", "codex+gpt", "看过了\n审阅结论：通过", ledger.Running, ledger.StageMerge},
		{"打回", "codex+gpt", "a.go:1 缺测试\n审阅结论：打回", ledger.Queued, ""},
		{"没写结论", "codex+gpt", "看过了", ledger.Blocked, ledger.StageReview},
		{"审阅者与原执行者同工具不算", "claude+sonnet", "审阅结论：通过", ledger.Blocked, ledger.StageReview},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := setup(t)
			dir := filepath.Join(t.TempDir(), "wt")
			e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
			e.gh.Open("t1-work", goodBody)
			task := e.delivered("做事", "claude+haiku", dir)
			detail := "分批写内容，保留后续批次表"
			if _, err := e.db.ExecContext(e.ctx, `UPDATE tasks SET detail = ? WHERE id = ?`, detail, task.ID); err != nil {
				t.Fatal(err)
			}
			const tell = "内容一次写全、写设计理念、删后续批次表"
			if err := ledger.Record(e.ctx, e.db, task.ID, "tell", "a7", tell); err != nil {
				t.Fatal(err)
			}
			e.sweep()
			if got := e.get(task.ID); got.Stage != ledger.StageReview {
				t.Fatalf("低信任应先审阅：%+v", got)
			}
			ref, ok, _ := gates.Last(e.ctx, e.db, task.ID, gates.KindReviewer)
			rt := e.get(ref)
			if !ok || rt.Status != ledger.Queued || rt.Parent != task.ID || !strings.Contains(rt.Detail, "审阅结论：通过") {
				t.Fatalf("审阅任务不对：%+v", rt)
			}
			if !strings.Contains(rt.Detail, "## 原任务详述\n\n"+detail) || !strings.Contains(rt.Detail, tell) || !strings.Contains(rt.Detail, "以后面为准") {
				t.Fatalf("审阅任务遗漏原说明、补充说明或优先级：%s", rt.Detail)
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
			// 代理查询明确报错：旧路径会读 choice.json 并把审阅转受阻。
			host, remoteDir := e.remoteAgent()
			if err := os.Mkdir(filepath.Join(remoteDir, "choice.json"), 0o700); err != nil {
				t.Fatal(err)
			}
			if _, err := hosts.Ask(e.ctx, host, hosts.Query{Dir: remoteDir, File: "choice.json"}); err == nil {
				t.Fatal("远程查询应返回读取目录的错误")
			}
			ledger.Record(e.ctx, e.db, rt.ID, gates.KindWorktree, "dispatch", `{"host":"`+host+`","dir":"`+filepath.ToSlash(remoteDir)+`"}`)
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

// 审阅任务失败、原任务转受阻后，审阅任务重跑出了结论：原任务照结论接着走，不用人转交。
func TestReviewRerunAfterBlock(t *testing.T) {
	cases := []struct {
		name   string
		result string
		status ledger.Status
		stage  ledger.Stage
		blocks int
	}{
		{"通过", "看过了\n审阅结论：通过", ledger.Running, ledger.StageMerge, 1},
		{"打回", "a.go:1 缺测试\n审阅结论：打回", ledger.Queued, "", 1},
		{"还是没写结论", "看过了", ledger.Blocked, ledger.StageReview, 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := setup(t)
			dir := filepath.Join(t.TempDir(), "wt")
			e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
			e.gh.Open("t1-work", goodBody)
			task := e.delivered("做事", "claude+haiku", dir)
			e.sweep()
			ref, _, _ := gates.Last(e.ctx, e.db, task.ID, gates.KindReviewer)
			e.db.ExecContext(e.ctx, `DELETE FROM queue WHERE task = ?`, ref)
			ledger.Apply(e.ctx, e.db, ref, ledger.Event{Kind: ledger.Start}, "dispatch", "")
			ledger.Apply(e.ctx, e.db, ref, ledger.Event{Kind: ledger.ExitFail}, "dispatch", "没登录")
			e.sweep()
			e.sweep() // 受阻后审阅任务没再出结论：原任务不动，也不重复记受阻
			if got := e.get(task.ID); got.Status != ledger.Blocked || got.Stage != ledger.StageReview || e.count(task.ID, "block") != 1 {
				t.Fatalf("审阅任务失败原任务应受阻一次：%+v，受阻 %d 次", got, e.count(task.ID, "block"))
			}

			time.Sleep(2 * time.Millisecond) // 结论新旧按毫秒比
			e.start(ref, "codex+gpt")        // 负责人改派重跑
			ledger.Record(e.ctx, e.db, ref, gates.KindResult, "dispatch", c.result)
			ledger.Record(e.ctx, e.db, ref, gates.KindWorktree, "dispatch", `{"host":"h1","dir":"`+filepath.ToSlash(t.TempDir())+`"}`)
			e.exit(ref)
			e.sweep()
			e.sweep()
			if got := e.get(ref); got.Status != ledger.Done {
				t.Fatalf("审阅任务应完成：%+v", got)
			}
			if got := e.get(task.ID); got.Status != c.status || got.Stage != c.stage || e.count(task.ID, "block") != c.blocks {
				t.Fatalf("原任务 %s/%s、受阻 %d 次，期望 %s/%s、%d 次：%s", got.Status, got.Stage, e.count(task.ID, "block"), c.status, c.stage, c.blocks, e.lastNote(task.ID))
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
	e.start(task.ID, "codex+gpt")
	ledger.Record(e.ctx, e.db, task.ID, gates.KindWorktree, "dispatch", `{"host":"h1","dir":"`+filepath.ToSlash(dir)+`"}`)
	ledger.Record(e.ctx, e.db, task.ID, gates.KindRisk, "u1", "high")
	e.exit(task.ID)
	e.sweep()
	if got := e.get(task.ID); got.Stage != ledger.StageReview {
		t.Fatalf("高风险应先审阅：%+v", got)
	}
}

func TestPausedSkipped(t *testing.T) {
	e := setup(t)
	task := e.delivered("做事", "claude+opus", "")
	(&pause.Store{DB: e.db}).Set(e.ctx, pause.All, "u1")
	e.sweep()
	if got := e.get(task.ID); got.Stage != ledger.StageGate || got.Status != ledger.Running {
		t.Fatalf("暂停时不动：%+v", got)
	}
}
