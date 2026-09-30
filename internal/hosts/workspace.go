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
func (a *Agent) worktree(ctx context.Context, as Assignment) (string, error) {
	clone := filepath.Join(a.Dir, "repos", CloneName(as.Repo))
	wt := clone + "-" + as.Task
	if _, err := os.Stat(wt); err == nil {
		branch, err := a.workspaceRun(ctx, wt, "git", "symbolic-ref", "--short", "HEAD")
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(branch) != as.Branch {
			return "", fmt.Errorf("任务 %s 的工作树 %s 在分支 %s 上，不是 %s；拉起前停止，由负责人核对分支归属，不要进入其他任务目录", as.Task, wt, strings.TrimSpace(branch), as.Branch)
		}
		return wt, nil // 同一任务再来一轮：接着用原工作树
	}
	if _, err := os.Stat(filepath.Join(clone, ".git")); err != nil {
		if err := a.git(ctx, "", "clone", "--quiet", "--", as.Repo, clone); err != nil {
			return "", err
		}
	} else if err := a.git(ctx, clone, "fetch", "--quiet", "origin"); err != nil {
		return "", err
	}
	if err := worktree.Create(ctx, clone, wt, as.Branch, "origin/"+as.Base, a.workspaceRun); err != nil {
		return "", err
	}
	return wt, nil
}
