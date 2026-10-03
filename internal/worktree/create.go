package worktree

import "context"

// Create 是本机与代理共用的重建入口：拒绝占用，再选原分支或默认基线，最后创建工作树。
// 目录必须还不存在或为空：有文件却没有 .git 的目录由 Ensure 拦下，不在这里补检出。
func Create(ctx context.Context, clone, dir, branch, fallback string, run Runner) error {
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
