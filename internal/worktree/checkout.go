package worktree

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Ensure 在把目录交给执行者（随后才会记成工作树）之前确认它就是这次检出。
// 目录还不存在或为空时先调 checkout 建成检出（checkout 为空表示这里不建）。
// 有文件却没有自己的 .git、或 git rev-parse --show-toplevel 不等于 dir 时，返回带路径与原因的错误，
// 调用方不得标记、不得拉起。只建成与校验，不改已有目录、也不修 Git 登记：异常状态停下交给负责人，
// 不在关键路径自愈。
func Ensure(ctx context.Context, dir string, run Runner, checkout func() error) error {
	fresh, err := freshDir(dir)
	if err != nil {
		return err
	}
	if fresh {
		if checkout != nil {
			if err := checkout(); err != nil {
				return err
			}
		}
	} else if err := ownGit(dir); err != nil {
		return err
	}
	return matchTop(ctx, dir, run)
}

// freshDir 为真：目录还不存在，或存在但是空目录（可以在这里建成检出）。
// 有文件却没有 .git 的目录不算：要么是别的东西，要么是上次没做完，都不在这里补。
func freshDir(dir string) (bool, error) {
	fi, err := os.Lstat(dir)
	if os.IsNotExist(err) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		return false, fmt.Errorf("目录 %s 不是检出：不是普通目录", dir)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false, err
	}
	return len(entries) == 0, nil
}

// ownGit 要求目录自己是这次检出：有它自己的 .git，而不是靠上级仓库。
func ownGit(dir string) error {
	if _, err := os.Lstat(filepath.Join(dir, ".git")); err != nil {
		return fmt.Errorf("目录 %s 不是检出：有文件却没有自己的 .git；拉起前停下，由负责人核对这些文件的来历，不要在上级目录干活", dir)
	}
	return nil
}

// Init 把目录初始化成它自己的空检出，原有文件保留。只用于任务没有仓库的时候：
// 这样 git 的顶层落在这里，不再走到上级仓库。
func Init(ctx context.Context, dir string, run Runner) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	_, err := run(ctx, dir, "git", "init", "--quiet", "-b", "main")
	return err
}

func matchTop(ctx context.Context, dir string, run Runner) error {
	top, err := run(ctx, dir, "git", "rev-parse", "--show-toplevel")
	if err != nil {
		return fmt.Errorf("目录 %s 不是检出：%w", dir, err)
	}
	top = strings.TrimSpace(top)
	if top != "" && !filepath.IsAbs(top) {
		top = filepath.Join(dir, top)
	}
	ok, err := samePath(dir, top)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("目录 %s 不是检出：git 顶层是 %s", dir, top)
	}
	return nil
}

func samePath(a, b string) (bool, error) {
	ra, err := resolvedPath(a)
	if err != nil {
		return false, err
	}
	rb, err := resolvedPath(b)
	if err != nil {
		return false, err
	}
	return ra == rb, nil
}
