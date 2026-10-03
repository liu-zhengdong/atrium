package worktree

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Ensure 在把目录交给执行者（随后才会记成工作树）之前确认它是这次检出。
// 目录不存在、为空，或有文件但没有自己的 .git 时，先调用 checkout；checkout 为空表示这里不该补检出。
// 复用已有目录时先接登记：补检在搬完 .git、worktree repair 接上之前中断的目录顶层看着对，登记却指向
// 已删除的临时目录，接着拉起会在回收时删不掉分支。再要求 git rev-parse --show-toplevel 解析后等于 dir。
// 任何一步不过就返回错误，调用方不得标记、不得拉起。
func Ensure(ctx context.Context, dir string, run Runner, checkout func() error) error {
	absent, err := absent(dir)
	if err != nil {
		return err
	}
	if absent {
		if checkout != nil {
			if err := checkout(); err != nil {
				return err
			}
		}
	} else if err := relink(ctx, dir, run); err != nil {
		return err
	}
	return matchTop(ctx, dir, run)
}

// relink 把 Git 的工作树登记接回 dir；修不好说明这个目录不是这次检出，交给调用方停下。
func relink(ctx context.Context, dir string, run Runner) error {
	if _, err := run(ctx, dir, "git", "worktree", "repair"); err != nil {
		return fmt.Errorf("目录 %s 不是检出：Git 工作树登记没接上：%w", dir, err)
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

// absent 为真：目录还不存在，或存在但没有自己的 .git。不把上级仓库当成这次检出。
func absent(dir string) (bool, error) {
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
	_, err = os.Lstat(filepath.Join(dir, ".git"))
	if os.IsNotExist(err) {
		return true, nil
	}
	return false, err
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
