package hosts

import (
	"context"
	"os"
	"path/filepath"
)

// worktree 在代理数据目录里克隆仓库（已有就 fetch）并为这个任务建工作树。
func (a *Agent) worktree(ctx context.Context, as Assignment) (string, error) {
	clone := filepath.Join(a.Dir, "repos", CloneName(as.Repo))
	wt := clone + "-" + as.Task
	if _, err := os.Stat(wt); err == nil {
		return wt, nil // 同一任务再来一轮：接着用原工作树
	}
	if _, err := os.Stat(filepath.Join(clone, ".git")); err != nil {
		if err := a.git(ctx, "", "clone", "--quiet", "--", as.Repo, clone); err != nil {
			return "", err
		}
	} else if err := a.git(ctx, clone, "fetch", "--quiet", "origin"); err != nil {
		return "", err
	}
	if err := a.git(ctx, clone, "worktree", "add", "--quiet", "-B", as.Branch, wt, "origin/"+as.Base); err != nil {
		return "", err
	}
	return wt, nil
}
