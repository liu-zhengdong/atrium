package worktree

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Ensure 在把目录交给执行者（随后才会记成工作树）之前确认它就是这次检出。
// 首次创建（目录还不存在）交给 checkout 建成；已存在的目录只校验，不重建、不修复。
// 校验不过（不是普通目录、没有自己的 .git、git 顶层不等于 dir）就返回带路径与原因的错误，
// 调用方不得标记、不得拉起：异常状态停下交给负责人，不在关键路径自愈。
func Ensure(ctx context.Context, dir string, run Runner, checkout func() error) error {
	if err := createIfMissing(dir, checkout); err != nil {
		return err
	}
	return validate(ctx, dir, run)
}

// createIfMissing 只做首次创建：目录还不存在时建成检出（checkout 为空表示这里不建）。
// 已存在的目录一律不碰——空目录也算没有检出，交给 validate 报错停下，不在这里补建。
func createIfMissing(dir string, checkout func() error) error {
	if _, err := os.Lstat(dir); !os.IsNotExist(err) {
		return nil
	}
	if checkout == nil {
		return nil
	}
	return checkout()
}

// validate 已有目录只校验、不修复：必须先是这次检出，不能靠上级仓库。
func validate(ctx context.Context, dir string, run Runner) error {
	fi, err := os.Lstat(dir)
	if os.IsNotExist(err) {
		return fmt.Errorf("目录 %s 不是检出：目录不存在", dir)
	}
	if err != nil {
		return err
	}
	if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		return fmt.Errorf("目录 %s 不是检出：不是普通目录", dir)
	}
	if err := ownGit(dir); err != nil {
		return err
	}
	return matchTop(ctx, dir, run)
}

// ownGit 要求目录自己是这次检出：有它自己的 .git，而不是靠上级仓库。
func ownGit(dir string) error {
	if _, err := os.Lstat(filepath.Join(dir, ".git")); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("目录 %s 不是检出：没有自己的 .git；拉起前停下，由负责人核对该目录的来历，不要在上级目录干活", dir)
		}
		return err
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
