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

// 目录还不存在：先建成检出，顶层等于自己。
func TestEnsureMissingDirChecksOut(t *testing.T) {
	gh, ctx, parent, dir := parentRepo(t, "task-t1")
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

// 已有空目录：不补检出、不标记，返回带路径与原因的错误；目录和上级仓库都不动。
func TestEnsureEmptyDirRefuses(t *testing.T) {
	gh, ctx, parent, dir := parentRepo(t, "task-t1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	before := gh.Must(parent, "rev-parse", "HEAD")
	err := worktree.Ensure(ctx, dir, gh.Git.Run, func() error {
		return worktree.Create(ctx, gh.Work, dir, "task-t1", "main", gh.Git.Run)
	})
	if err == nil || !strings.Contains(err.Error(), "不是检出") || !strings.Contains(err.Error(), "没有自己的 .git") {
		t.Fatalf("应拒绝并说明缺 .git：%v", err)
	}
	if entries, readErr := os.ReadDir(dir); readErr != nil || len(entries) != 0 {
		t.Fatalf("拒绝时改了目录：%v %v", entries, readErr)
	}
	if list := gh.Must(gh.Work, "worktree", "list", "--porcelain"); strings.Contains(list, "task-t1") {
		t.Fatalf("拒绝时仍建了工作树：%s", list)
	}
	assertParentUntouched(t, gh, parent, before)
}

// 有文件但没有自己的 .git：不补检出、不标记，返回带路径与原因的错误，目录和上级仓库都不动。
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
	if err == nil || !strings.Contains(err.Error(), "不是检出") || !strings.Contains(err.Error(), "没有自己的 .git") {
		t.Fatalf("应拒绝并说明缺 .git：%v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, ".git")); !os.IsNotExist(statErr) {
		t.Fatal("拒绝时仍做成了检出")
	}
	if body, readErr := os.ReadFile(filepath.Join(dir, "keep.txt")); readErr != nil || string(body) != "keep" {
		t.Fatalf("拒绝时改了目录：%q %v", body, readErr)
	}
	if list := gh.Must(gh.Work, "worktree", "list", "--porcelain"); strings.Contains(list, "task-t1") {
		t.Fatalf("拒绝时仍建了工作树：%s", list)
	}
	assertParentUntouched(t, gh, parent, before)
}

// 目录有自己的 .git 但 git 顶层不是它（core.worktree 指到别处）：不标记，报明顶层。
func TestEnsureRejectsWrongToplevel(t *testing.T) {
	gh, ctx, parent, dir := parentRepo(t, "main")
	gh.Must(parent, "init", "--quiet", "-b", "main", dir)
	gh.Must(dir, "config", "core.worktree", parent)
	before := gh.Must(parent, "rev-parse", "HEAD")
	err := worktree.Ensure(ctx, dir, gh.Git.Run, nil)
	if err == nil || !strings.Contains(err.Error(), "不是检出") || !strings.Contains(err.Error(), "git 顶层是") {
		t.Fatalf("应拒绝并说明顶层不符：%v", err)
	}
	assertParentUntouched(t, gh, parent, before)
}

// 已有自己的 .git 且顶层正确：直接复用，不再建成、不修登记。
func TestEnsureReusesExistingCheckout(t *testing.T) {
	gh, ctx, parent, dir := parentRepo(t, "main")
	if err := worktree.Ensure(ctx, dir, gh.Git.Run, func() error {
		return worktree.Init(ctx, dir, gh.Git.Run)
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "work.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := gh.Must(parent, "rev-parse", "HEAD")
	rebuilt := false
	if err := worktree.Ensure(ctx, dir, gh.Git.Run, func() error {
		rebuilt = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if rebuilt {
		t.Fatal("已有检出时不该再建成")
	}
	if body, err := os.ReadFile(filepath.Join(dir, "work.txt")); err != nil || string(body) != "x" {
		t.Fatalf("复用改了目录：%q %v", body, err)
	}
	assertOwnTop(t, gh, dir)
	assertParentUntouched(t, gh, parent, before)
}

// 没有仓库的任务：空的 work/ 初始化成它自己的检出，git 不再走到上级。
func TestEnsureInitSealsOwnTop(t *testing.T) {
	gh, ctx, parent, dir := parentRepo(t, "main")
	before := gh.Must(parent, "rev-parse", "HEAD")
	if err := worktree.Ensure(ctx, dir, gh.Git.Run, func() error {
		return worktree.Init(ctx, dir, gh.Git.Run)
	}); err != nil {
		t.Fatal(err)
	}
	assertOwnTop(t, gh, dir)
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		t.Fatal(err)
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
