package worktree_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/gates/fakegh"
	"github.com/liu-zhengdong/atrium/internal/worktree"
)

func TestRemoveRejectsWrongBranch(t *testing.T) {
	gh := fakegh.New(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dir := filepath.Join(t.TempDir(), "repo")
	gh.Must(gh.Work, "worktree", "add", "--quiet", "-b", "task-t2", dir, "main")
	if err := worktree.Remove(ctx, gh.Work, dir, "task-t1", gh.Git.Run); err == nil {
		t.Fatal("应拒绝删其他任务分支")
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("误删工作树：%v", err)
	}
}

func TestRemoveMissingDirectoryAndBranch(t *testing.T) {
	gh := fakegh.New(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dir := filepath.Join(t.TempDir(), "repo")
	gh.Must(gh.Work, "worktree", "add", "--quiet", "-b", "task-t1", dir, "main")
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	} // 模拟回收中途退出：目录没了，Git 登记与分支仍在
	if err := worktree.Remove(ctx, gh.Work, dir, "task-t1", gh.Git.Run); err != nil {
		t.Fatal(err)
	}
	if out := gh.Must(gh.Work, "branch", "--list", "task-t1"); out != "" {
		t.Fatalf("残留分支：%s", out)
	}
	if err := worktree.Remove(ctx, gh.Work, dir, "task-t1", gh.Git.Run); err != nil {
		t.Fatal(err)
	}
}
