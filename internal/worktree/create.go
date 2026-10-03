package worktree

import (
	"context"
	"fmt"
	"os"
)

// Create 是本机与代理共用的重建入口：目录须不存在或为空，拒绝占用，再选原分支或默认基线，最后创建工作树。
// 目录里已有文件却没有 .git 时不搬动它们，返回错误由负责人核对。
func Create(ctx context.Context, clone, dir, branch, fallback string, run Runner) error {
	if entries, err := os.ReadDir(dir); err == nil && len(entries) > 0 {
		return fmt.Errorf("目录 %s 不是检出：里面有文件但没有 .git；拉起前停止，由负责人核对这些文件的来历，不要在上级目录干活", dir)
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := Available(ctx, clone, branch, run); err != nil {
		return err
	}
	base, err := Base(ctx, clone, branch, fallback, run)
	if err != nil {
		return err
	}
	_, err = run(ctx, clone, "git", "worktree", "add", "--quiet", "-B", branch, dir, base)
	return err
}
