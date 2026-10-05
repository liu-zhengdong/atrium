package gates_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/gates/fakegh"
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
		"combos/dsh+opus":   "---\ntrust: medium\nchecks: [finished, pr_exists, claims_verified]\n---\n",
		"combos/dsh+k2":     "---\ntrust: low\n---\n",
		"combos/dsh+gpt":    "---\ntrust: high\n---\n",
		"combos/dsh+sonnet": "---\ntrust: high\n---\n",
		"combos/dsh+haiku":  "---\ntrust: low\n---\n",
	} {
		if _, err := db.ExecContext(e.ctx, `INSERT INTO worker_profiles (name, spec, updated_by, updated_at) VALUES (?, ?, 'u1', 0)`, name, spec); err != nil {
			t.Fatal(err)
		}
	}
	oldReview := gates.Review
	gates.Review = func(ctx context.Context, id, who string) error { e.reviewLaunch(id, who); return nil }
	t.Cleanup(func() { gates.Review = oldReview })
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
	task := e.delivered("做事", "dsh+opus", dir)
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
			task := e.delivered("做事", "dsh+opus", dir)
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
		{"GitHub 仓库没有改动", false, false, ledger.Done, "没有代码改动"},
		{"GitHub 仓库只有未提交文件", false, true, ledger.Queued, "未提交"},
		{"本机仓库没有改动", true, false, ledger.Done, "没有代码改动"},
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
				task = e.delivered("在 h3 装工具", "dsh+opus", dir)
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
// 受阻说明以执行者的结论开头，不写成交付检查不过：没有改动不是受阻的原因（t923 交资料 m163、自报没做成，被读成「没 diff 被拦」）。
func TestGateEnding(t *testing.T) {
	cases := []struct {
		name  string
		repo  bool // 有仓库但工作树没改动；否则没有仓库
		reply string
		stale bool // 回复记在这一轮拉起之前
		want  ledger.Status
		note  string
	}{
		{"没改动、完成", true, "资料 m163\n交付结论：完成", false, ledger.Done, "没有代码改动，交付结论：完成"},
		{"没改动、没做成", true, "h3 上读不到设计稿\n交付结论：没做成", false, ledger.Blocked, "执行者交付结论：没做成（h3 上读不到设计稿）（没有代码改动，按交付结论判）"},
		{"没改动、受阻", true, "等 t983\n交付结论：受阻", false, ledger.Blocked, "交付结论：受阻（等 t983）：停下等外部依赖，不算失败；负责人解除后 atrium task run 继续（没有代码改动）"},
		{"没仓库、停下等决定", false, "两个方案等负责人定\n交付结论：没做成", false, ledger.Blocked, "执行者交付结论：没做成（两个方案等负责人定）（没有仓库"},
		{"没仓库、未完成", false, "还差一步\n交付结论：未完成", false, ledger.Blocked, "执行者交付结论：未完成（还差一步）"},
		{"没仓库、受阻", false, "等证书\n交付结论：受阻", false, ledger.Blocked, "交付结论：受阻（等证书）"},
		{"没仓库、没写结论", false, "没做成，没改代码也没开 PR", false, ledger.Blocked, "执行者最后一行没写「交付结论"},
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
			e.start(task.ID, "dsh+opus")
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
			if note := e.lastNote(task.ID); strings.Contains(note, "交付检查未通过") || strings.Contains(note, "不要 PR") {
				t.Fatalf("按交付结论停下不是交付检查不过：%s", note)
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
	task := e.delivered("做事", "dsh+opus", "")
	e.sweep()
	if got := e.get(task.ID); got.Status != ledger.Blocked || !strings.Contains(e.lastNote(task.ID), "没有工作树登记") {
		t.Fatalf("没有工作树登记应受阻：%+v %s", got, e.lastNote(task.ID))
	}
}

// 没有仓库的任务（调研）：过交付检查即完成；工作目录根有 choice.json 就登记成选项单，不合法交回执行者改。
func TestGateNoRepo(t *testing.T) {
	good := `{"title":"下一步","options":[` + strings.Repeat(`{"title":"A","gain":"g","why_now":"w","cost":"c","if_not":"i","evidence":"m1/27.svg"},`, 2) +
		`{"title":"B","gain":"g","why_now":"w","cost":"c","if_not":"i","evidence":"m1/27.svg"}],"recommend":[2],"reason":"r"}`
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
			e.choiceMaterial(d.ID)
			task, _ := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "调研", Org: d.ID}, "u1")
			e.start(task.ID, "dsh+k2")
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

// reviewLaunch 模拟 dispatch 在原任务上拉起审阅，作者登记保持原样。
func (e *env) reviewLaunch(id, who string) {
	e.t.Helper()
	if who == "" {
		who = "dsh+gpt"
	}
	last, err := workers.LastRun(e.ctx, e.db, id)
	if err != nil {
		e.t.Fatal(err)
	}
	n := 1
	if last != nil {
		n = last.N + 1
	}
	raw, _ := json.Marshal(workers.Run{N: n, Why: workers.WhyReview, Worker: who, Host: "h1"})
	if err := ledger.Record(e.ctx, e.db, id, workers.RunKind, "dispatch", string(raw)); err != nil {
		e.t.Fatal(err)
	}
	if err := ledger.Record(e.ctx, e.db, id, gates.KindReviewer, "dispatch", `{"worker":"`+who+`"}`); err != nil {
		e.t.Fatal(err)
	}
}
func (e *env) reviewExit(id, reply string) {
	e.t.Helper()
	last, err := workers.LastRun(e.ctx, e.db, id)
	if err != nil || last == nil {
		e.t.Fatalf("last run: %v %v", last, err)
	}
	if err := ledger.Record(e.ctx, e.db, id, gates.KindResult, "dispatch", reply); err != nil {
		e.t.Fatal(err)
	}
	raw, _ := json.Marshal(workers.Exit{N: last.N})
	if err := ledger.Record(e.ctx, e.db, id, workers.ExitKind, "dispatch", string(raw)); err != nil {
		e.t.Fatal(err)
	}
}
func TestReview(t *testing.T) {
	for _, c := range []struct {
		name, reply string
		status      ledger.Status
		stage       ledger.Stage
	}{
		{"通过", "看过了\n审阅结论：通过", ledger.Running, ledger.StageMerge},
		{"打回", "a.go:1 缺测试\n审阅结论：打回", ledger.Queued, ledger.StageNone},
		{"没结论", "看过了", ledger.Running, ledger.StageReview},
		{"末行不对", "审阅结论：通过\n交付结论：完成", ledger.Running, ledger.StageReview},
		{"空回复", "", ledger.Running, ledger.StageReview},
	} {
		t.Run(c.name, func(t *testing.T) {
			e := setup(t)
			dir := filepath.Join(t.TempDir(), "wt")
			e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
			e.gh.Open("t1-work", goodBody)
			task := e.delivered("做事", "dsh+haiku", dir)
			ledger.Record(e.ctx, e.db, task.ID, "tell", "a7", "保留完整内容")
			e.sweep()
			brief, err := gates.RoundBrief(e.ctx, e.db, e.get(task.ID), e.gh)
			if err != nil || !strings.Contains(brief, "保留完整内容") || !strings.Contains(brief, "审阅结论：通过") {
				t.Fatalf("brief %s %v", brief, err)
			}
			// 收线到一个工具后只要求换模型审：不记 not_tool，记作者用的模型。
			req, _, _ := gates.Last(e.ctx, e.db, task.ID, gates.KindRequire)
			if !strings.Contains(req, `"not_tool":""`) || !strings.Contains(req, `"not_model":"haiku"`) {
				t.Fatal(req)
			}
			e.sweep()
			if e.count(task.ID, workers.RunKind) != 1 {
				t.Fatal("重复拉起")
			}
			e.reviewExit(task.ID, c.reply)
			e.sweep()
			got := e.get(task.ID)
			if got.Status != c.status || got.Stage != c.stage || got.Worker != "dsh+haiku" {
				t.Fatalf("%+v", got)
			}
			var total int
			e.db.QueryRowContext(e.ctx, `SELECT count(*) FROM tasks`).Scan(&total)
			if total != 1 {
				t.Fatalf("出现平行任务 %d", total)
			}
			if c.stage != ledger.StageReview && e.count(task.ID, gates.KindReview) != 1 {
				t.Fatal("没记结论")
			}

		})
	}
}
func TestReviewMissingThreeTimes(t *testing.T) {
	e := setup(t)
	dir := filepath.Join(t.TempDir(), "wt")
	e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
	e.gh.Open("t1-work", goodBody)
	task := e.delivered("做事", "dsh+haiku", dir)
	e.sweep()
	for i := 1; i <= 3; i++ {
		e.reviewExit(task.ID, "读不出结论")
		e.sweep()
		got := e.get(task.ID)
		want := ledger.Running
		if i == 3 {
			want = ledger.Blocked
		}
		if got.Status != want || got.Stage != ledger.StageReview {
			t.Fatalf("第%d次 %+v", i, got)
		}
	}
	e.sweep()
	if e.count(task.ID, workers.RunKind) != 3 || e.count(task.ID, "block") != 1 {
		t.Fatal("受阻后重复审阅")
	}
}

func TestHighRiskReviewed(t *testing.T) {
	e := setup(t)
	dir := filepath.Join(t.TempDir(), "wt")
	e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
	e.gh.Open("t1-work", goodBody)
	task, _ := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "做事", Repo: "o/r"}, "u1")
	e.start(task.ID, "dsh+gpt")
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
	task := e.delivered("做事", "dsh+opus", "")
	(&pause.Store{DB: e.db}).Set(e.ctx, pause.All, "u1")
	e.sweep()
	if got := e.get(task.ID); got.Stage != ledger.StageGate || got.Status != ledger.Running {
		t.Fatalf("暂停时不动：%+v", got)
	}
}
