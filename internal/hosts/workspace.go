package hosts

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/worktree"
)

// worktree 在代理数据目录里克隆仓库（已有就 fetch）并为这个任务建工作树。
// 目录还不存在或为空时先检出；有文件却没有自己的 .git、或 git 顶层不是该目录时不把它交给执行者。
func (a *Agent) worktree(ctx context.Context, as Assignment) (string, error) {
	clone := filepath.Join(a.Dir, "repos", CloneName(as.Repo))
	wt := clone + "-" + as.Task
	if err := os.MkdirAll(filepath.Dir(wt), 0o700); err != nil {
		return "", err
	}
	if err := worktree.Ensure(ctx, wt, a.workspaceRun, func() error {
		return a.checkoutRepo(ctx, as, clone, wt)
	}); err != nil {
		return "", err
	}
	branch, err := a.workspaceRun(ctx, wt, "git", "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(branch) != as.Branch {
		return "", fmt.Errorf("任务 %s 的工作树 %s 在分支 %s 上，不是 %s；拉起前停止，由负责人核对分支归属，不要进入其他任务目录", as.Task, wt, strings.TrimSpace(branch), as.Branch)
	}
	return wt, nil
}

// plainWork 是没有仓库的任务目录。初始化成自己的检出，避免 git 走到上级。
func (a *Agent) plainWork(ctx context.Context, task string) (string, error) {
	dir := filepath.Join(a.Dir, "tasks", task, "work")
	err := worktree.Ensure(ctx, dir, a.workspaceRun, func() error {
		return worktree.Init(ctx, dir, a.workspaceRun)
	})
	return dir, err
}

// workDir 是这次拉起的工作目录：有仓库用工作树，没有就用任务目录下的 work/。
func (a *Agent) workDir(ctx context.Context, as Assignment) (string, error) {
	if as.Repo != "" {
		return a.worktree(ctx, as)
	}
	return a.plainWork(ctx, as.Task)
}

func (a *Agent) checkoutRepo(ctx context.Context, as Assignment, clone, wt string) error {
	if _, err := os.Stat(filepath.Join(clone, ".git")); err != nil {
		if err := a.git(ctx, "", "clone", "--quiet", "--", as.Repo, clone); err != nil {
			return err
		}
	} else if err := a.git(ctx, clone, "fetch", "--quiet", "origin"); err != nil {
		return err
	}
	return worktree.Create(ctx, clone, wt, as.Branch, "origin/"+as.Base, a.workspaceRun)
}
