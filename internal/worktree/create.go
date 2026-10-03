package worktree

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// Create 是本机与代理共用的重建入口：拒绝占用，再选原分支或默认基线，最后创建工作树。
// 目录里已有文件却没有 .git 时保留这些文件、在原地补检出（见 adopt）。
func Create(ctx context.Context, clone, dir, branch, fallback string, run Runner) error {
	if err := Available(ctx, clone, branch, run); err != nil {
		return err
	}
	base, err := Base(ctx, clone, branch, fallback, run)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if len(entries) > 0 {
		return adopt(ctx, clone, dir, branch, base, run)
	}
	_, err = run(ctx, clone, "git", "worktree", "add", "--quiet", "-B", branch, dir, base)
	return err
}

// adopt 把已有文件、没有 .git 的目录做成工作树：先对照起点提交查冲突，有冲突就报错、什么都不动；
// 没有冲突时在旁边建工作树，把跟踪的文件搬进目录，最后才移 .git 并修复登记。
// 跟踪内容在 .git 之前就位：任何一步失败时目录都还没有 .git，下一轮不会把半成品当成检出放行。
func adopt(ctx context.Context, clone, dir, branch, base string, run Runner) error {
	tracked, err := run(ctx, clone, "git", "ls-tree", "-r", "-z", "--name-only", base)
	if err != nil {
		return err
	}
	files := splitZ(tracked)
	existing, err := listTree(dir)
	if err != nil {
		return err
	}
	if c := conflicts(existing, files, caseInsensitive(dir)); len(c) > 0 {
		return fmt.Errorf("目录 %s 不是检出：里面没有 .git，已有的 %v 与任务仓库的文件冲突；拉起前停止，由负责人核对这些文件的来历，不要在上级目录干活", dir, c)
	}
	side := dir + ".checkout"
	if _, err := os.Lstat(side); err == nil {
		return fmt.Errorf("目录 %s 不是检出：补检出要用的 %s 已存在，由负责人核对后删掉", dir, side)
	} else if !os.IsNotExist(err) {
		return err
	}
	if _, err := run(ctx, clone, "git", "worktree", "add", "--quiet", "-B", branch, side, base); err != nil {
		return err
	}
	for _, f := range files {
		dst := filepath.Join(dir, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			return err
		}
		if err := os.Rename(filepath.Join(side, filepath.FromSlash(f)), dst); err != nil {
			return err
		}
	}
	if err := os.Rename(filepath.Join(side, ".git"), filepath.Join(dir, ".git")); err != nil {
		return err
	}
	if err := os.RemoveAll(side); err != nil {
		return err
	}
	_, err = run(ctx, dir, "git", "worktree", "repair")
	return err
}
