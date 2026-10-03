package dispatch

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/ledger"
)

// 任务目录的上级恰好在同名分支上，空的 repo/ 不能被当成工作树：拒绝且不建。
func TestWorkdirEmptyDirRefuses(t *testing.T) {
	d, gh, ctx := reclaimRig(t)
	tk, err := ledger.Add(ctx, d.env.DB, ledger.NewTask{Title: "空目录拒绝", Repo: gh.Work}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	parent := TaskDir(d.env.Paths.Data, tk.ID)
	branch := Branch(tk.ID)
	gh.Must(d.env.Paths.Data, "init", "--quiet", "-b", branch, parent)
	gh.Must(parent, "commit", "--quiet", "--allow-empty", "-m", "parent")
	repo := filepath.Join(parent, "repo")
	if err := os.MkdirAll(repo, 0o700); err != nil {
		t.Fatal(err)
	}
	before := gh.Must(parent, "rev-parse", "HEAD")
	dir, gotBranch, err := Workdir(ctx, d.env.Paths.Data, tk.ID, gh.Work, "")
	if err == nil || !strings.Contains(err.Error(), "不是检出") || !strings.Contains(err.Error(), "没有自己的 .git") {
		t.Fatalf("应拒绝并说明缺 .git：%s %s %v", dir, gotBranch, err)
	}
	if _, statErr := os.Stat(filepath.Join(repo, ".git")); !os.IsNotExist(statErr) {
		t.Fatal("拒绝时仍做成了检出")
	}
	if list := gh.Must(gh.Work, "worktree", "list", "--porcelain"); strings.Contains(list, "task-t") {
		t.Fatalf("拒绝时仍建了工作树：%s", list)
	}
	if head := gh.Must(parent, "rev-parse", "HEAD"); head != before {
		t.Fatalf("改了上级仓库：%s", head)
	}
}

// 没有仓库时 work/ 也必须是自己的检出，不能沿用上级仓库。
func TestWorkdirNoRepoSealsOwnTop(t *testing.T) {
	d, gh, ctx := reclaimRig(t)
	tk, err := ledger.Add(ctx, d.env.DB, ledger.NewTask{Title: "无仓库"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	parent := TaskDir(d.env.Paths.Data, tk.ID)
	gh.Must(d.env.Paths.Data, "init", "--quiet", "-b", "main", parent)
	gh.Must(parent, "commit", "--quiet", "--allow-empty", "-m", "parent")
	before := gh.Must(parent, "rev-parse", "HEAD")
	dir, branch, err := Workdir(ctx, d.env.Paths.Data, tk.ID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if branch != "" || dir != filepath.Join(parent, "work") {
		t.Fatalf("工作目录 %s %s", dir, branch)
	}
	top := gh.Must(dir, "rev-parse", "--show-toplevel")
	got, err := filepath.EvalSymlinks(top)
	if err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("顶层 %s，目录 %s", got, want)
	}
	if head := gh.Must(parent, "rev-parse", "HEAD"); head != before {
		t.Fatalf("改了上级仓库：%s", head)
	}
}
