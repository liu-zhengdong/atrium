package merge_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/gates/fakegh"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/merge"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestOrder(t *testing.T) {
	got := merge.Order([]merge.Item{{"t1", 2, 10}, {"t2", 0, 30}, {"t3", 2, 5}, {"t4", 0, 20}})
	var ids []string
	for _, it := range got {
		ids = append(ids, it.Task)
	}
	if want := []string{"t4", "t2", "t3", "t1"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("%v", ids)
	}
}

func recordWorktree(e *env, task ledger.Task) string {
	e.t.Helper()
	dir := filepath.Join(filepath.Dir(e.q.Dir), "tasks", task.ID, "repo")
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		e.t.Fatal(err)
	}
	e.gh.Must(e.gh.Work, "worktree", "add", "--quiet", "-b", "task-"+task.ID, dir, "main")
	if err := ledger.Record(e.ctx, e.db, task.ID, gates.KindWorktree, "dispatch", fmt.Sprintf(`{"host":"h1","dir":%q}`, dir)); err != nil {
		e.t.Fatal(err)
	}
	return dir
}

func TestBounceKeepsWorktree(t *testing.T) {
	e := setup(t, nil)
	task := e.deliver("t1-a", map[string]string{"README.md": "mine\n"})
	dir := recordWorktree(e, task)
	e.gh.Commit(map[string]string{"README.md": "theirs\n"})
	e.drain()
	if got := e.get(task.ID); got.Status != ledger.Queued {
		t.Fatalf("应交回：%+v", got)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("交回后工作树丢失：%v", err)
	}
}

func TestBlockedKeepsWorktree(t *testing.T) {
	e := setup(t, nil)
	task := e.deliver("t1-a", map[string]string{"a.go": "package a\n"})
	dir := recordWorktree(e, task)
	e.gh.PRs[0].State = "CLOSED"
	e.drain()
	if got := e.get(task.ID); got.Status != ledger.Blocked {
		t.Fatalf("PR 关闭应受阻：%+v", got)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("受阻后工作树丢失：%v", err)
	}
}

func TestParsePR(t *testing.T) {
	cases := []struct {
		in   string
		repo string
		n    int
		ok   bool
	}{
		{"12", "", 12, true},
		{"#12", "", 12, true},
		{"https://github.com/o/r/pull/7", "o/r", 7, true},
		{"https://github.com/o/r/pull/7/", "o/r", 7, true},
		{"https://gitlab.com/o/r/pull/7", "", 0, false},
		{"0", "", 0, false},
		{"abc", "", 0, false},
	}
	for _, c := range cases {
		repo, n, err := merge.ParsePR(c.in)
		if repo != c.repo || n != c.n || (err == nil) != c.ok {
			t.Errorf("%q：%q %d %v", c.in, repo, n, err)
		}
	}
}

func TestTail(t *testing.T) {
	if got := merge.Tail("a\nb\nc\n", 2); got != "b\nc" {
		t.Fatal(got)
	}
}

type env struct {
	t   *testing.T
	ctx context.Context
	db  *store.DB
	gh  *fakegh.GH
	q   *merge.Queue
}

func setup(t *testing.T, files map[string]string) *env {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	gh := fakegh.New(t, files)
	return &env{t: t, ctx: context.Background(), db: db, gh: gh,
		q: &merge.Queue{DB: db, Pause: &pause.Store{DB: db}, R: gh, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
			Dir: filepath.Join(t.TempDir(), "merge"), CIReport: 5 * time.Millisecond}}
}

// deliver 模拟执行者推了分支、开了 PR，再用 task merge 的路径放进合入队列。
func (e *env) deliver(branch string, files map[string]string) ledger.Task {
	e.t.Helper()
	e.gh.Branch(filepath.Join(e.t.TempDir(), "wt"), branch, files)
	n := e.gh.Open(branch, "")
	task, err := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: branch}, "u1")
	if err != nil {
		e.t.Fatal(err)
	}
	got, err := merge.Deliver(e.ctx, e.db, e.gh, task.ID, merge.Body{PR: "https://github.com/o/r/pull/" + strconv.Itoa(n)}, "u1")
	if err != nil {
		e.t.Fatal(err)
	}
	if got.Status != ledger.Running || got.Stage != ledger.StageMerge || got.Repo != "o/r" {
		e.t.Fatalf("task merge 后应在合入队列：%+v", got)
	}
	return got
}

func (e *env) drain() {
	e.t.Helper()
	if err := e.q.Drain(e.ctx); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) get(id string) ledger.Task {
	t, err := ledger.Get(e.ctx, e.db, id)
	if err != nil {
		e.t.Fatal(err)
	}
	return t
}

func (e *env) lastNote(id string) string {
	h, _ := ledger.History(e.ctx, e.db, id, 50)
	return h[len(h)-1].Body
}

func TestMergeRebasesAndMerges(t *testing.T) {
	e := setup(t, map[string]string{".agents/check": "#!/bin/sh\necho checking\ntest -f a.go\n"})
	task := e.deliver("t1-a", map[string]string{"a.go": "package a\n"})
	e.gh.Commit(map[string]string{"other.go": "package o\n"}) // main 先前进了：要 rebase
	e.drain()
	got := e.get(task.ID)
	if got.Status != ledger.Done || got.Stage != ledger.StageMerged {
		t.Fatalf("应合入完成：%+v %s", got, e.lastNote(task.ID))
	}
	commit, _, _ := gates.Last(e.ctx, e.db, task.ID, gates.KindMergeCommit)
	if !strings.Contains(commit, `"commit":"`) {
		t.Fatalf("没记合入提交：%s", commit)
	}
	files := e.gh.Must(e.gh.Bare, "ls-tree", "--name-only", "main")
	if !strings.Contains(files, "a.go") || !strings.Contains(files, "other.go") {
		t.Fatalf("main 上应有两边的文件：%s", files)
	}
}

func TestMergeNeedRelease(t *testing.T) {
	e := setup(t, nil)
	e.q.NeedRelease = func(repo string) bool { return repo == "o/r" }
	task := e.deliver("t1-a", map[string]string{"a.go": "package a\n"})
	e.drain()
	if got := e.get(task.ID); got.Status != ledger.Running || got.Stage != ledger.StageMerged {
		t.Fatalf("自己的仓库合入后等发版：%+v", got)
	}
	skipped := false
	h, _ := ledger.History(e.ctx, e.db, task.ID, 50)
	for _, ev := range h {
		skipped = skipped || (ev.Kind == gates.KindMerge && strings.Contains(ev.Body, "skipped"))
	}
	if !skipped {
		t.Fatal("没有 .agents/check 应记一笔跳过")
	}
}

func TestMergeConflictBounces(t *testing.T) {
	e := setup(t, nil)
	task := e.deliver("t1-a", map[string]string{"README.md": "mine\n"})
	e.gh.Commit(map[string]string{"README.md": "theirs\n"})
	e.drain()
	got := e.get(task.ID)
	if got.Status != ledger.Queued || !strings.Contains(e.lastNote(task.ID), "README.md") {
		t.Fatalf("冲突应交回并列出文件：%+v %s", got, e.lastNote(task.ID))
	}
	if e.gh.PRs[0].State != "OPEN" {
		t.Fatal("冲突时不该合")
	}
}

func TestMergeCheckFailBounces(t *testing.T) {
	e := setup(t, map[string]string{".agents/check": "#!/bin/sh\necho 'FAIL TestX'\nexit 1\n"})
	task := e.deliver("t1-a", map[string]string{"a.go": "package a\n"})
	before := e.gh.Must(e.gh.Bare, "rev-parse", "refs/heads/t1-a")
	e.gh.Commit(map[string]string{"other.go": "package o\n"})
	e.drain()
	got := e.get(task.ID)
	if got.Status != ledger.Queued || !strings.Contains(e.lastNote(task.ID), "FAIL TestX") {
		t.Fatalf("检查没过应交回并附输出：%+v %s", got, e.lastNote(task.ID))
	}
	if after := e.gh.Must(e.gh.Bare, "rev-parse", "refs/heads/t1-a"); after != before {
		t.Fatal("检查没过不该推送 rebase 后的分支")
	}
}

// 远端 CI 全绿才合；红交回并附 check 名与结论链接；没配 CI 直合（行为不变）；等满上限交回写明超时。
func TestMergeGreenCIMerges(t *testing.T) {
	e := setup(t, nil)
	task := e.deliver("t1-a", map[string]string{"a.go": "package a\n"})
	e.gh.PRs[0].Checks = []fakegh.Check{{Name: "check", Bucket: "pass", Link: "https://ci/1"}}
	e.drain()
	if got := e.get(task.ID); got.Status != ledger.Done {
		t.Fatalf("CI 全绿应合入：%+v %s", got, e.lastNote(task.ID))
	}
}

func TestMergeRedCIBounces(t *testing.T) {
	e := setup(t, nil)
	task := e.deliver("t1-a", map[string]string{"a.go": "package a\n"})
	e.gh.PRs[0].Checks = []fakegh.Check{
		{Name: "check", Bucket: "fail", Link: "https://ci/1"},
		{Name: "e2e", Bucket: "pass", Link: "https://ci/2"},
	}
	e.drain()
	got := e.get(task.ID)
	if got.Status != ledger.Queued {
		t.Fatalf("CI 红应交回：%+v", got)
	}
	if note := e.lastNote(task.ID); !strings.Contains(note, "check") || !strings.Contains(note, "https://ci/1") {
		t.Fatalf("交回应附失败的 check 名与结论链接：%s", note)
	}
	if e.gh.PRs[0].State != "OPEN" {
		t.Fatal("CI 红不该合")
	}
}

func TestMergeNoCIMergesDirectly(t *testing.T) {
	e := setup(t, nil)
	task := e.deliver("t1-a", map[string]string{"a.go": "package a\n"})
	e.drain()
	got := e.get(task.ID)
	if got.Status != ledger.Done {
		t.Fatalf("没配 CI 应直合：%+v %s", got, e.lastNote(task.ID))
	}
	h, _ := ledger.History(e.ctx, e.db, task.ID, 50)
	for _, ev := range h {
		if ev.Kind == gates.KindMerge && strings.Contains(ev.Body, `"ci":"skipped"`) {
			return
		}
	}
	t.Fatal("没配 CI 应记一笔跳过")
}

func TestMergeCITimeoutBounces(t *testing.T) {
	e := setup(t, nil)
	e.q.CIWait = 100 * time.Millisecond
	task := e.deliver("t1-a", map[string]string{"a.go": "package a\n"})
	e.gh.PRs[0].Checks = []fakegh.Check{{Name: "check", Bucket: "pending", Link: "https://ci/1"}}
	e.drain()
	got := e.get(task.ID)
	if got.Status != ledger.Queued {
		t.Fatalf("等 CI 超时应交回：%+v", got)
	}
	if note := e.lastNote(task.ID); !strings.Contains(note, "超时") {
		t.Fatalf("交回应写明等 CI 超时：%s", note)
	}
	if e.gh.PRs[0].State != "OPEN" {
		t.Fatal("等 CI 超时不该合")
	}
}

// 第三次交回转受阻；task merge 放行后重新进队列、交回次数重算。
func TestThirdBounceBlocksAndMergeReleases(t *testing.T) {
	e := setup(t, map[string]string{".agents/check": "#!/bin/sh\nexit 1\n"})
	task := e.deliver("t1-a", map[string]string{"a.go": "package a\n"})
	for i := 0; i < 3; i++ {
		e.drain()
		got := e.get(task.ID)
		if i < 2 {
			if got.Status != ledger.Queued {
				t.Fatalf("第 %d 次应交回：%+v", i+1, got)
			}
			// 模拟 dispatch 重派、执行者再次交付、交付检查再过
			e.db.ExecContext(e.ctx, `DELETE FROM queue WHERE task = ?`, task.ID)
			for _, k := range []ledger.EventKind{ledger.Start, ledger.ExitOK, ledger.GatePass} {
				if _, err := ledger.Apply(e.ctx, e.db, task.ID, ledger.Event{Kind: k, Land: ledger.StageMerge}, "t", ""); err != nil {
					t.Fatal(err)
				}
			}
		} else if got.Status != ledger.Blocked {
			t.Fatalf("第三次应受阻：%+v", got)
		}
	}
	if _, err := merge.Deliver(e.ctx, e.db, e.gh, task.ID, merge.Body{}, "u1"); err != nil {
		t.Fatal(err)
	}
	if n, _ := ledger.Bounces(e.ctx, e.db, task.ID); n != 0 {
		t.Fatalf("放行后交回次数应重算，得到 %d", n)
	}
	if _, err := merge.Deliver(e.ctx, e.db, e.gh, task.ID, merge.Body{}, "u1"); err == nil {
		t.Fatal("已在队列里不能再放")
	}
}

func TestDeliverRejects(t *testing.T) {
	e := setup(t, nil)
	task, _ := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "x"}, "u1")
	for _, b := range []merge.Body{{}, {PR: "9", Repo: "o/r"}, {PR: "1", Repo: "bad"}, {PR: "https://github.com/x/y/pull/1"}} {
		if _, err := merge.Deliver(e.ctx, e.db, e.gh, task.ID, b, "u1"); err == nil {
			t.Errorf("%+v 应拒绝", b)
		}
	}
	if got := e.get(task.ID); got.Status != ledger.Todo || got.PR != "" {
		t.Fatalf("拒绝时不该改任务：%+v", got)
	}
}

func TestHasFailures(t *testing.T) {
	for out, want := range map[string]bool{
		"--- FAIL: TestX (0.1s)":  true,
		"FAIL\tgithub.com/x 0.1s": true,
		"not ok 3 - adds":         true,
		"12 passing\n2 failing":   true,
		"# fail 0\nok 1 - x":      false,
		"started\nrunning…":       false,
		"0 failed":                false,
	} {
		if got := merge.HasFailures(out); got != want {
			t.Errorf("%q：%v", out, got)
		}
	}
}

// 模拟 watch：每登记一个新的检查进程，记一笔 watch 经历并结束它的进程树。
// 按登记数认新进程：重跑的检查还没登记时不能再杀上一个（Windows 上拉起慢，t366）。
func killWhenTracked(e *env, id string, times int) {
	go func() {
		seen := 0
		for seen < times {
			var procs int
			e.db.QueryRowContext(e.ctx, `SELECT count(*) FROM task_events WHERE task = ? AND kind = 'proc'`, id).Scan(&procs)
			var body string
			var pid int
			e.db.QueryRowContext(e.ctx, `SELECT body FROM task_events WHERE task = ? AND kind = 'proc' ORDER BY id DESC LIMIT 1`, id).Scan(&body)
			if i := strings.Index(body, `"pid":`); i >= 0 {
				fmt.Sscanf(body[i+6:], "%d", &pid)
			}
			if pid > 0 && procs > seen {
				time.Sleep(200 * time.Millisecond) // 等脚本先打出输出
				ledger.Record(e.ctx, e.db, id, "watch", "runtime", `{"role":"check","action":"kill"}`)
				platform.KillTree(pid)
				seen++
			}
			time.Sleep(20 * time.Millisecond)
		}
	}()
}

func TestStalledCheckRerunsOnceThenBounces(t *testing.T) {
	e := setup(t, map[string]string{".agents/check": "#!/bin/sh\necho started\nsleep 30\n"})
	task := e.deliver("t1-a", map[string]string{"a.go": "package a\n"})
	killWhenTracked(e, task.ID, 2)
	start := time.Now()
	e.drain()
	if time.Since(start) > 20*time.Second {
		t.Fatal("没有结束检查")
	}
	var procs int
	e.db.QueryRowContext(e.ctx, `SELECT count(*) FROM task_events WHERE task = ? AND kind = 'proc'`, task.ID).Scan(&procs)
	if got := e.get(task.ID); got.Status != ledger.Queued || procs != 2 || !strings.Contains(e.lastNote(task.ID), "两次") {
		t.Fatalf("没失败用例应重跑一次再交回：%+v procs=%d %s", got, procs, e.lastNote(task.ID))
	}
}

func TestStalledCheckWithFailuresBounces(t *testing.T) {
	e := setup(t, map[string]string{".agents/check": "#!/bin/sh\necho '--- FAIL: TestY'\nsleep 30\n"})
	task := e.deliver("t1-a", map[string]string{"a.go": "package a\n"})
	killWhenTracked(e, task.ID, 1)
	e.drain()
	var procs int
	e.db.QueryRowContext(e.ctx, `SELECT count(*) FROM task_events WHERE task = ? AND kind = 'proc'`, task.ID).Scan(&procs)
	if got := e.get(task.ID); got.Status != ledger.Queued || procs != 1 || !strings.Contains(e.lastNote(task.ID), "FAIL: TestY") {
		t.Fatalf("有失败用例直接交回：%+v procs=%d %s", got, procs, e.lastNote(task.ID))
	}
}

func TestPausedNotMerged(t *testing.T) {
	e := setup(t, nil)
	task := e.deliver("t1-a", map[string]string{"a.go": "package a\n"})
	(&pause.Store{DB: e.db}).Set(e.ctx, pause.All, "u1")
	e.drain()
	if got := e.get(task.ID); got.Stage != ledger.StageMerge || got.Status != ledger.Running {
		t.Fatalf("暂停时不合：%+v", got)
	}
}

// 验收人是用户的部门：负责人放行的交付先等你验收，合入队列不碰；验收通过后进合入队列并合入。
func TestAcceptThenMerge(t *testing.T) {
	e := setup(t, nil)
	d, err := org.Add(e.ctx, e.db, org.NewDept{Name: "哆啦美"})
	if err != nil {
		t.Fatal(err)
	}
	who := org.AcceptUser
	if _, err := org.Edit(e.ctx, e.db, d.ID, org.DeptPatch{Accept: &who}); err != nil {
		t.Fatal(err)
	}
	e.gh.Branch(filepath.Join(t.TempDir(), "wt"), "t1-a", map[string]string{"a.go": "package a\n"})
	n := e.gh.Open("t1-a", "")
	task, _ := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "交付", Org: d.ID}, "u1")
	got, err := merge.Deliver(e.ctx, e.db, e.gh, task.ID, merge.Body{PR: "https://github.com/o/r/pull/" + strconv.Itoa(n)}, "a1")
	if err != nil || got.Status != ledger.Running || got.Stage != ledger.StageAccept {
		t.Fatalf("负责人放行应先等你验收：%+v %v", got, err)
	}
	e.drain()
	if got := e.get(task.ID); got.Stage != ledger.StageAccept {
		t.Fatalf("合入队列不该碰等验收的：%+v", got)
	}
	g := &gates.Gate{DB: e.db, Pause: e.q.Pause, R: e.gh, Log: e.q.Log}
	if got, err := g.Accept(e.ctx, task.ID, "u1"); err != nil || got.Stage != ledger.StageMerge {
		t.Fatalf("验收通过应进合入队列：%+v %v", got, err)
	}
	e.drain()
	if got := e.get(task.ID); got.Status != ledger.Done || got.Stage != ledger.StageMerged {
		t.Fatalf("应合入完成：%+v %s", got, e.lastNote(task.ID))
	}
	if files := e.gh.Must(e.gh.Bare, "ls-tree", "--name-only", "main"); !strings.Contains(files, "a.go") {
		t.Fatalf("main 上应有 a.go：%s", files)
	}
}
