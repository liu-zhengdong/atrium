package worktree_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/gates/fakegh"
	"github.com/liu-zhengdong/atrium/internal/worktree"
)

// 上级仓库的分支名与任务分支相同。旧顺序会把空目录当成检出（git 向上找到上级）。
func TestEnsureEmptyDirChecksOut(t *testing.T) {
	gh, ctx, parent, dir := parentRepo(t, "task-t1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	before := gh.Must(parent, "rev-parse", "HEAD")
	if err := worktree.Ensure(ctx, dir, gh.Git.Run, func() error {
		return worktree.Create(ctx, gh.Work, dir, "task-t1", "main", gh.Git.Run)
	}); err != nil {
		t.Fatal(err)
	}
	assertOwnTop(t, gh, dir)
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		t.Fatal(err)
	}
	if body := gh.Must(dir, "show", "HEAD:README.md"); body != "hi" {
		t.Fatalf("没有检出任务仓库：%q", body)
	}
	assertParentUntouched(t, gh, parent, before)
}

// 有文件但没有 .git：不搬动文件、不做成检出，报明确错误。
func TestEnsureFilesWithoutGitRefuses(t *testing.T) {
	gh, ctx, parent, dir := parentRepo(t, "task-t1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep.txt"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := gh.Must(parent, "rev-parse", "HEAD")
	err := worktree.Ensure(ctx, dir, gh.Git.Run, func() error {
		return worktree.Create(ctx, gh.Work, dir, "task-t1", "main", gh.Git.Run)
	})
	if err == nil || !strings.Contains(err.Error(), "不是检出") || !strings.Contains(err.Error(), "有文件但没有 .git") {
		t.Fatalf("应拒绝并说明不是检出：%v", err)
	}
	if body, readErr := os.ReadFile(filepath.Join(dir, "keep.txt")); readErr != nil || string(body) != "keep" {
		t.Fatalf("拒绝时改了目录：%q %v", body, readErr)
	}
	if _, statErr := os.Stat(filepath.Join(dir, ".git")); !os.IsNotExist(statErr) {
		t.Fatal("拒绝时仍做成了检出")
	}
	if list := gh.Must(gh.Work, "worktree", "list", "--porcelain"); strings.Contains(list, "task-t1") {
		t.Fatalf("拒绝时仍建了工作树：%s", list)
	}
	assertParentUntouched(t, gh, parent, before)
}

// 没有仓库的任务：有文件也初始化成自己的检出，文件留着。
func TestEnsureInitKeepsFiles(t *testing.T) {
	gh, ctx, parent, dir := parentRepo(t, "main")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep.txt"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := gh.Must(parent, "rev-parse", "HEAD")
	if err := worktree.Ensure(ctx, dir, gh.Git.Run, func() error {
		return worktree.Init(ctx, dir, gh.Git.Run)
	}); err != nil {
		t.Fatal(err)
	}
	assertOwnTop(t, gh, dir)
	if body, err := os.ReadFile(filepath.Join(dir, "keep.txt")); err != nil || string(body) != "keep" {
		t.Fatalf("原有文件没留下：%q %v", body, err)
	}
	assertParentUntouched(t, gh, parent, before)
}

// 顶层是上级目录时不把这里当成工作树，也不改上级仓库。
func TestEnsureRejectsParentToplevel(t *testing.T) {
	gh, ctx, parent, dir := parentRepo(t, "main")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep.txt"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := gh.Must(parent, "rev-parse", "HEAD")
	marked := false
	err := worktree.Ensure(ctx, dir, gh.Git.Run, nil)
	if err == nil {
		marked = true
	}
	if marked || err == nil || !strings.Contains(err.Error(), "不是检出") || !strings.Contains(err.Error(), "git 顶层是") {
		t.Fatalf("应拒绝并说明不是检出：marked=%v %v", marked, err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, ".git")); !os.IsNotExist(statErr) {
		t.Fatal("拒绝时仍做成了检出")
	}
	if body, readErr := os.ReadFile(filepath.Join(dir, "keep.txt")); readErr != nil || string(body) != "keep" {
		t.Fatalf("拒绝时改了目录：%q %v", body, readErr)
	}
	assertParentUntouched(t, gh, parent, before)
}

func parentRepo(t *testing.T, branch string) (*fakegh.GH, context.Context, string, string) {
	t.Helper()
	gh := fakegh.New(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	parent := filepath.Join(t.TempDir(), "home")
	gh.Must(filepath.Dir(parent), "init", "--quiet", "-b", branch, parent)
	gh.Must(parent, "commit", "--quiet", "--allow-empty", "-m", "parent")
	return gh, ctx, parent, filepath.Join(parent, "work")
}

func assertOwnTop(t *testing.T, gh *fakegh.GH, dir string) {
	t.Helper()
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
}

func assertParentUntouched(t *testing.T, gh *fakegh.GH, parent, before string) {
	t.Helper()
	if head := gh.Must(parent, "rev-parse", "HEAD"); head != before {
		t.Fatalf("改了上级仓库：%s → %s", before, head)
	}
	if diff := gh.Must(parent, "diff", "HEAD"); diff != "" {
		t.Fatalf("改了上级仓库：%s", diff)
	}
}
