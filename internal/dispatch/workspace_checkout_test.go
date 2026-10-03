package dispatch

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/ledger"
)

// 任务目录的上级恰好在同名分支上，空的 repo/ 不能被当成工作树。
func TestWorkdirEmptyDirDoesNotInheritParent(t *testing.T) {
	d, gh, ctx := reclaimRig(t)
	tk, err := ledger.Add(ctx, d.env.DB, ledger.NewTask{Title: "空目录先检出", Repo: gh.Work}, "u1")
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
	if err != nil {
		t.Fatal(err)
	}
	if dir != repo || gotBranch != branch {
		t.Fatalf("工作目录 %s %s", dir, gotBranch)
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
	if body := gh.Must(dir, "show", "HEAD:README.md"); body != "hi" {
		t.Fatalf("没有检出任务仓库：%q", body)
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
