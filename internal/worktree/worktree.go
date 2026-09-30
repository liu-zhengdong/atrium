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
	list, err := run(ctx, "", "git", "--git-dir", clone, "worktree", "list", "--porcelain")
	if err != nil {
		return err
	}
	for _, line := range strings.Split(list, "\n") {
		if path, ok := strings.CutPrefix(line, "worktree "); ok && filepath.Clean(strings.TrimSpace(path)) == filepath.Clean(dir) {
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
