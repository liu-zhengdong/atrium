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

func TestRemoveThroughSymlink(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "目录存在", true: "目录已删除"}[missing], func(t *testing.T) {
			gh := fakegh.New(t, nil)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			root := t.TempDir()
			actual := filepath.Join(root, "actual")
			if err := os.Mkdir(actual, 0700); err != nil {
				t.Fatal(err)
			}
			alias := filepath.Join(root, "alias")
			if err := os.Symlink(actual, alias); err != nil {
				t.Skipf("当前环境不支持创建符号链接：%v", err)
			}
			dir := filepath.Join(alias, "repo")
			gh.Must(gh.Work, "worktree", "add", "--quiet", "-b", "task-t1", dir, "main")
			if missing {
				if err := os.RemoveAll(dir); err != nil {
					t.Fatal(err)
				}
			}
			if err := worktree.Remove(ctx, gh.Work, dir, "task-t1", gh.Git.Run); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(dir); !os.IsNotExist(err) {
				t.Fatalf("别名下工作树未删除：%v", err)
			}
			if out := gh.Must(gh.Work, "branch", "--list", "task-t1"); out != "" {
				t.Fatalf("残留分支：%s", out)
			}
		})
	}
}

func TestRemoveQuotedPath(t *testing.T) {
	gh := fakegh.New(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dir := filepath.Join(t.TempDir(), "中文 repo")
	gh.Must(gh.Work, "-c", "core.quotePath=true", "worktree", "add", "--quiet", "-b", "task-t1", dir, "main")
	if err := worktree.Remove(ctx, gh.Work, dir, "task-t1", gh.Git.Run); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("特殊字符工作树未删除：%v", err)
	}
	if out := gh.Must(gh.Work, "branch", "--list", "task-t1"); out != "" {
		t.Fatalf("残留分支：%s", out)
	}
}
