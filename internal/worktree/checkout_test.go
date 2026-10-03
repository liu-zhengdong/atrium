package worktree_test

import (
	"context"
	"errors"
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

// 有文件但没有 .git：原有文件留着，在原地补检出任务仓库。
func TestEnsureFilesWithoutGitChecksOut(t *testing.T) {
	gh, ctx, parent, dir := parentRepo(t, "task-t1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep.txt"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := gh.Must(parent, "rev-parse", "HEAD")
	if err := worktree.Ensure(ctx, dir, gh.Git.Run, func() error {
		return worktree.Create(ctx, gh.Work, dir, "task-t1", "main", gh.Git.Run)
	}); err != nil {
		t.Fatal(err)
	}
	assertOwnTop(t, gh, dir)
	if branch := gh.Must(dir, "symbolic-ref", "--short", "HEAD"); branch != "task-t1" {
		t.Fatalf("分支 %s", branch)
	}
	if body, err := os.ReadFile(filepath.Join(dir, "README.md")); err != nil || strings.TrimSpace(string(body)) != "hi" {
		t.Fatalf("没有写出任务仓库的文件：%q %v", body, err)
	}
	if body, err := os.ReadFile(filepath.Join(dir, "keep.txt")); err != nil || string(body) != "keep" {
		t.Fatalf("原有文件没留下：%q %v", body, err)
	}
	if status := gh.Must(dir, "status", "--porcelain"); status != "?? keep.txt" {
		t.Fatalf("检出后状态 %q", status)
	}
	if _, err := os.Stat(dir + ".checkout"); !os.IsNotExist(err) {
		t.Fatalf("旁边的临时目录没删：%v", err)
	}
	if list := gh.Must(gh.Work, "worktree", "list", "--porcelain"); strings.Count(list, "worktree ") != 2 {
		t.Fatalf("工作树登记 %s", list)
	}
	assertParentUntouched(t, gh, parent, before)
}

// 已有文件与任务仓库的文件同名：报明确错误，目录和仓库都不动。
func TestEnsureConflictingFilesRefuses(t *testing.T) {
	gh, ctx, parent, dir := parentRepo(t, "task-t1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := gh.Must(parent, "rev-parse", "HEAD")
	err := worktree.Ensure(ctx, dir, gh.Git.Run, func() error {
		return worktree.Create(ctx, gh.Work, dir, "task-t1", "main", gh.Git.Run)
	})
	if err == nil || !strings.Contains(err.Error(), "不是检出") || !strings.Contains(err.Error(), "README.md") {
		t.Fatalf("应拒绝并说明冲突：%v", err)
	}
	if body, readErr := os.ReadFile(filepath.Join(dir, "README.md")); readErr != nil || string(body) != "mine" {
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

// 第一次检出失败时目录不能留下 .git：否则下一轮会把它当成可复用的检出直接放行（t927 审阅 P1）。
func TestEnsureRetryAfterFailedCheckout(t *testing.T) {
	gh, ctx, parent, dir := parentRepo(t, "task-t1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep.txt"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := gh.Must(parent, "rev-parse", "HEAD")
	fail := true
	run := func(c context.Context, d, name string, args ...string) (string, error) {
		if fail && name == "git" && len(args) > 1 && args[0] == "worktree" && args[1] == "add" {
			return "", errors.New("注入：检出失败")
		}
		return gh.Git.Run(c, d, name, args...)
	}
	checkout := func() error { return worktree.Create(ctx, gh.Work, dir, "task-t1", "main", run) }
	if err := worktree.Ensure(ctx, dir, run, checkout); err == nil {
		t.Fatal("第一次检出应失败")
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); !os.IsNotExist(err) {
		t.Fatal("失败后目录留下了 .git，下一轮会把它当成检出放行")
	}
	fail = false
	if err := worktree.Ensure(ctx, dir, run, checkout); err != nil {
		t.Fatal(err)
	}
	assertOwnTop(t, gh, dir)
	if body, err := os.ReadFile(filepath.Join(dir, "README.md")); err != nil || strings.TrimSpace(string(body)) != "hi" {
		t.Fatalf("重试没有完成检出：%q %v", body, err)
	}
	assertParentUntouched(t, gh, parent, before)
}

// 目标文件系统不区分大小写时（Windows 与默认的 macOS），已有的 readme.md 挡住仓库里的 README.md，拉起前拒绝。
func TestEnsureCaseOnlyConflictRefuses(t *testing.T) {
	gh, ctx, parent, dir := parentRepo(t, "task-t1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "readme.md"), []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := gh.Must(parent, "rev-parse", "HEAD")
	err := worktree.Ensure(ctx, dir, gh.Git.Run, func() error {
		return worktree.Create(ctx, gh.Work, dir, "task-t1", "main", gh.Git.Run)
	})
	if !fsCaseInsensitive(t, dir) {
		if err != nil {
			t.Fatalf("区分大小写的文件系统上不该冲突：%v", err)
		}
		return
	}
	if err == nil || !strings.Contains(err.Error(), "readme.md") || !strings.Contains(err.Error(), "冲突") {
		t.Fatalf("大小写不同的同名文件应拒绝：%v", err)
	}
	if body, readErr := os.ReadFile(filepath.Join(dir, "readme.md")); readErr != nil || string(body) != "mine" {
		t.Fatalf("拒绝时改了目录：%q %v", body, readErr)
	}
	if _, statErr := os.Stat(filepath.Join(dir, ".git")); !os.IsNotExist(statErr) {
		t.Fatal("拒绝时仍做成了检出")
	}
	assertParentUntouched(t, gh, parent, before)
}

// 仓库里首个跟踪文件带前导空格时原样比对：Runner 不再 TrimSpace 掉它，冲突要查出来。
func TestEnsureLeadingSpaceConflictRefuses(t *testing.T) {
	gh, ctx, parent, dir := parentRepo(t, "task-t1")
	gh.Write(gh.Work, " leading.txt", "x")
	gh.Must(gh.Work, "add", "-A")
	gh.Must(gh.Work, "commit", "--quiet", "-m", "leading space")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, " leading.txt"), []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := gh.Must(parent, "rev-parse", "HEAD")
	err := worktree.Ensure(ctx, dir, gh.Git.Run, func() error {
		return worktree.Create(ctx, gh.Work, dir, "task-t1", "main", gh.Git.Run)
	})
	if err == nil || !strings.Contains(err.Error(), " leading.txt") || !strings.Contains(err.Error(), "冲突") {
		t.Fatalf("带前导空格的同名文件应被检出冲突：%v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, ".git")); !os.IsNotExist(statErr) {
		t.Fatal("拒绝时仍做成了检出")
	}
	assertParentUntouched(t, gh, parent, before)
}

// fsCaseInsensitive 用一次独立探针问文件系统：该目录所在卷是否不区分大小写。
func fsCaseInsensitive(t *testing.T, dir string) bool {
	t.Helper()
	f, err := os.CreateTemp(dir, "probe-")
	if err != nil {
		t.Fatal(err)
	}
	name := f.Name()
	f.Close()
	defer os.Remove(name)
	_, err = os.Stat(filepath.Join(dir, strings.ToUpper(filepath.Base(name))))
	return err == nil
}
