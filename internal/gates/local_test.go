package gates_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
)

// localRepo 建一个普通本机仓库：main 上一个初始提交，没有远程。
func (e *env) localRepo() string {
	e.t.Helper()
	repo := filepath.Join(e.t.TempDir(), "site")
	e.gh.Must(filepath.Dir(repo), "init", "--quiet", "-b", "main", repo)
	e.gh.Write(repo, "a.txt", "one\n")
	e.gh.Must(repo, "add", "-A")
	e.gh.Must(repo, "commit", "--quiet", "-m", "init")
	return repo
}

// localTask 造一件本机交付的任务：照 dispatch.Workdir 在仓库上开任务工作树（分支 task-tN），执行者写入 files、
// commit 为真时提交，然后正常退出停在关卡。
func (e *env) localTask(dept, repo string, files map[string]string, commit bool) (ledger.Task, string) {
	e.t.Helper()
	t, err := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "写文章", Org: dept, Repo: repo}, "u1")
	if err != nil {
		e.t.Fatal(err)
	}
	e.start(t.ID, "claude+opus")
	wt := filepath.Join(e.t.TempDir(), "wt")
	e.gh.Must(repo, "worktree", "add", "--quiet", "-B", "task-"+t.ID, wt, "HEAD")
	for name, body := range files {
		e.gh.Write(wt, name, body)
	}
	if commit {
		e.gh.Must(wt, "add", "-A")
		e.gh.Must(wt, "commit", "--quiet", "-m", "写完")
	}
	if err := ledger.Record(e.ctx, e.db, t.ID, gates.KindWorktree, "dispatch", `{"host":"h1","dir":"`+filepath.ToSlash(wt)+`"}`); err != nil {
		e.t.Fatal(err)
	}
	return e.exit(t.ID), wt
}

// onMain 在本机仓库的 main 上直接加一个提交（模拟用户自己又改了）。
func (e *env) onMain(repo, name, body string) {
	e.t.Helper()
	e.gh.Write(repo, name, body)
	e.gh.Must(repo, "add", "-A")
	e.gh.Must(repo, "commit", "--quiet", "-m", "用户改 "+name)
}

func (e *env) file(dir, name string) string {
	b, _ := os.ReadFile(filepath.Join(dir, name))
	return string(b)
}

// landedOn 核对关卡的落地职责：主分支有了任务改动，工作树留给 dispatch 在终态统一回收。
func (e *env) landedOn(repo, wt, id, name, body string) {
	e.t.Helper()
	if got := e.file(repo, name); got != body {
		e.t.Fatalf("主工作树里 %s 应为 %q：%q", name, body, got)
	}
	if _, err := os.Stat(wt); err != nil {
		e.t.Fatalf("关卡不应提前删除任务工作树：%v", err)
	}
	if out := e.gh.Must(repo, "branch", "--list", "task-"+id); out == "" {
		e.t.Fatalf("关卡不应提前删除任务分支：%s", out)
	}
}

// 关卡在本机查事实：有未提交改动交回；有提交就过，验收人 auto 当场合进本机主分支（没有改动见 TestGateNoChanges）。
func TestLocalGate(t *testing.T) {
	cases := []struct {
		name   string
		files  map[string]string
		commit bool
		dirty  bool
		want   string
	}{
		{"有未提交改动", map[string]string{"post.md": "正文\n"}, true, true, "未提交"},
		{"有提交", map[string]string{"post.md": "正文\n"}, true, false, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := setup(t)
			repo := e.localRepo()
			task, wt := e.localTask("", repo, c.files, c.commit)
			if c.dirty {
				e.gh.Write(wt, "draft.md", "草稿\n")
			}
			e.sweep()
			got := e.get(task.ID)
			if c.want != "" {
				if got.Status != ledger.Queued || !strings.Contains(e.lastNote(task.ID), c.want) {
					t.Fatalf("应交回且原因含 %q：%+v %s", c.want, got, e.lastNote(task.ID))
				}
				if e.file(repo, "post.md") != "" {
					t.Fatal("没过关卡不该动主分支")
				}
				return
			}
			if got.Status != ledger.Done || !strings.Contains(e.lastNote(task.ID), "快进") {
				t.Fatalf("应过关卡并快进合进 main：%+v %s", got, e.lastNote(task.ID))
			}
			e.landedOn(repo, wt, task.ID, "post.md", "正文\n")
			if len(e.gh.Calls) != 0 {
				t.Fatalf("本机交付不该调 gh：%v", e.gh.Calls)
			}
		})
	}
}

// 落地：主分支在派活后又有提交时先在任务工作树里合入主分支再快进；冲突交回原执行者，主分支与工作树都不留半截合并。
func TestLocalLand(t *testing.T) {
	t.Run("主分支有新提交不冲突", func(t *testing.T) {
		e := setup(t)
		repo := e.localRepo()
		task, wt := e.localTask("", repo, map[string]string{"post.md": "正文\n"}, true)
		e.onMain(repo, "other.md", "别的\n")
		e.sweep()
		if got := e.get(task.ID); got.Status != ledger.Done || !strings.Contains(e.lastNote(task.ID), "先合入 main 再快进") {
			t.Fatalf("应合入后快进：%+v %s", got, e.lastNote(task.ID))
		}
		e.landedOn(repo, wt, task.ID, "post.md", "正文\n")
		if e.file(repo, "other.md") != "别的\n" {
			t.Fatal("用户在 main 上的提交丢了")
		}
	})
	t.Run("冲突交回", func(t *testing.T) {
		e := setup(t)
		repo := e.localRepo()
		task, wt := e.localTask("", repo, map[string]string{"a.txt": "执行者改的\n"}, true)
		e.onMain(repo, "a.txt", "用户改的\n")
		before := e.gh.Must(repo, "rev-parse", "main")
		e.sweep()
		got := e.get(task.ID)
		if got.Status != ledger.Queued || !strings.Contains(e.lastNote(task.ID), "有冲突（a.txt）") {
			t.Fatalf("冲突应交回：%+v %s", got, e.lastNote(task.ID))
		}
		if after := e.gh.Must(repo, "rev-parse", "main"); after != before || e.file(repo, "a.txt") != "用户改的\n" {
			t.Fatal("冲突时不该动主分支")
		}
		if st := e.gh.Must(wt, "status", "--porcelain"); st != "" || e.file(wt, "a.txt") != "执行者改的\n" {
			t.Fatalf("任务工作树应退回合并前：%q", st)
		}
	})
}

// 部门验收人是用户：关卡过了停在等验收、不动主分支；task accept 之后才合进本机主分支。
func TestLocalAccept(t *testing.T) {
	e := setup(t)
	o := e.dept(org.AcceptUser)
	repo := e.localRepo()
	task, wt := e.localTask(o, repo, map[string]string{"post.md": "正文\n"}, true)
	e.sweep()
	if got := e.state(task.ID); got != "running/accept" {
		t.Fatalf("应等验收：%s %s", got, e.lastNote(task.ID))
	}
	if e.file(repo, "post.md") != "" {
		t.Fatal("验收前不该合进主分支")
	}
	got, err := e.g.Accept(e.ctx, task.ID, "u1")
	if err != nil || got.Status != ledger.Done {
		t.Fatalf("验收通过应合进主分支并完成：%+v %v", got, err)
	}
	e.landedOn(repo, wt, task.ID, "post.md", "正文\n")
}
