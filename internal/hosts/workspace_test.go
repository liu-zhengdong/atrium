package hosts

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAgentWorkspaceBranchOwnership(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("USERPROFILE", root)
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(root, "gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	seed := filepath.Join(root, "seed")
	gitRun(t, "", "init", "--quiet", "-b", "main", seed)
	gitRun(t, seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "初始")
	a := NewAgent(filepath.Join(root, "agent"), AgentConfig{}, nil)
	if err := os.MkdirAll(filepath.Join(a.Dir, "repos"), 0700); err != nil {
		t.Fatal(err)
	}
	as := Assignment{Task: "t1", Repo: seed, Branch: "task-t1", Base: "main"}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dir, err := a.worktree(ctx, as)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := a.worktree(ctx, as); err != nil || again != dir {
		t.Fatalf("原任务不能续用：%s %v", again, err)
	}
	gitRun(t, dir, "checkout", "--quiet", "-b", "task-t2")
	if _, err := a.worktree(ctx, as); err == nil || !strings.Contains(err.Error(), "不是 task-t1") {
		t.Fatalf("误用其他分支：%v", err)
	}
	// 模拟另一个任务持有原分支，原任务重建时必须报错，不接管它。
	gitRun(t, filepath.Join(a.Dir, "repos", CloneName(seed)), "worktree", "remove", dir)
	clone := filepath.Join(a.Dir, "repos", CloneName(seed))
	other := clone + "-t642"
	gitRun(t, clone, "worktree", "add", "--quiet", other, "task-t1")
	if _, err := a.worktree(ctx, as); err == nil || !strings.Contains(err.Error(), "t642") || !strings.Contains(err.Error(), "拉起前停止") {
		t.Fatalf("代理未报告占用者：%v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("误删占用者：%v", err)
	}
}
