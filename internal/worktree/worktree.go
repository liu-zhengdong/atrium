// Package worktree 管理运行时创建的 Git 工作树；调用者负责核实任务与目录归属。
package worktree

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type Runner func(context.Context, string, string, ...string) (string, error)

// LocalMutation 沿用本机落地的串行锁：合入主分支与回收不能同时使用、删除同一个工作树。
var LocalMutation sync.Mutex

// Remove 同时删除工作树（含未跟踪的依赖）与本地任务分支。目录不存在时仍清掉 Git 登记和分支。
func Remove(ctx context.Context, clone, dir, branch string, run Runner) error {
	LocalMutation.Lock()
	defer LocalMutation.Unlock()
	if fi, err := os.Lstat(dir); err == nil {
		if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
			return fmt.Errorf("工作树 %s 不是普通目录", dir)
		}
		current, err := run(ctx, dir, "git", "symbolic-ref", "--short", "HEAD")
		if err != nil {
			return err
		}
		if strings.TrimSpace(current) != branch {
			return fmt.Errorf("工作树 %s 不在任务分支 %s", dir, branch)
		}
		common, err := run(ctx, dir, "git", "rev-parse", "--git-common-dir")
		if err != nil {
			return err
		}
		common = strings.TrimSpace(common)
		if !filepath.IsAbs(common) {
			common = filepath.Join(dir, common)
		}
		clone = common
	} else if !os.IsNotExist(err) {
		return err
	} else {
		if _, err := os.Stat(clone); os.IsNotExist(err) {
			return nil
		} else if err != nil {
			return err
		}
		common, err := run(ctx, clone, "git", "rev-parse", "--git-common-dir")
		if err != nil {
			return err
		}
		common = strings.TrimSpace(common)
		if !filepath.IsAbs(common) {
			common = filepath.Join(clone, common)
		}
		clone = common
	}
	target, err := resolvedPath(dir)
	if err != nil {
		return err
	}
	list, err := run(ctx, "", "git", "--git-dir", clone, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return err
	}
	for _, field := range strings.Split(list, "\x00") {
		path, ok := strings.CutPrefix(field, "worktree ")
		if !ok {
			continue
		}
		registered, err := resolvedPath(path)
		if err != nil {
			return err
		}
		if registered == target {
			if _, err := run(ctx, "", "git", "--git-dir", clone, "worktree", "remove", "--force", dir); err != nil {
				return err
			}
		}
	}
	ref, err := run(ctx, "", "git", "--git-dir", clone, "branch", "--list", branch)
	if err != nil {
		return err
	}
	if strings.TrimSpace(ref) != "" {
		_, err = run(ctx, "", "git", "--git-dir", clone, "branch", "-D", branch)
	}
	return err
}

// resolvedPath 统一 Git 登记与调用方路径里的符号链接。目录已消失时仍解析存活的祖先，
// 使 /var 与 /private/var 这类别名下的残留登记也能删除。
func resolvedPath(path string) (string, error) {
	path = filepath.Clean(path)
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return resolved, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	parent := filepath.Dir(path)
	if parent == path {
		return "", err
	}
	resolved, err = resolvedPath(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(path)), nil
}

// Base 在重建时优先接回已推送的任务分支；不存在时从默认基线重新开始。
func Base(ctx context.Context, clone, branch, fallback string, run Runner) (string, error) {
	ref := "origin/" + branch
	full := "refs/remotes/" + ref
	out, err := run(ctx, clone, "git", "for-each-ref", "--format=%(refname)", full)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(out) == full {
		return ref, nil
	}
	return fallback, nil
}
