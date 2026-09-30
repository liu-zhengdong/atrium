package worktree

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

var taskDirRE = regexp.MustCompile(`(?:^|-)t[1-9][0-9]*$`)

// Available 在重建分支之前核对 Git 的工作树登记；不移动、不删除其他任务的工作树。
func Available(ctx context.Context, clone, branch string, run Runner) error {
	list, err := run(ctx, clone, "git", "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return err
	}
	dir := occupied(list, branch)
	if dir == "" {
		return nil
	}
	owner := taskAt(dir)
	if owner != "" {
		return fmt.Errorf("分支 %s 被任务 %s 的工作树 %s 占用；拉起前停止。先用 atrium task show %s 核对；续做该 PR 应回到原任务（task tell、task set --status todo、task run），由负责人处理工作树归属，不要让执行者进入别的任务目录", branch, owner, dir, owner)
	}
	return fmt.Errorf("分支 %s 被工作树 %s 占用（无法确认任务）；拉起前停止，由负责人核对并处理占用，不要让执行者进入该目录", branch, dir)
}

func occupied(list, branch string) string {
	dir := ""
	for _, field := range strings.Split(list, "\x00") {
		if path, ok := strings.CutPrefix(field, "worktree "); ok {
			dir = path
		}
		if field == "branch refs/heads/"+branch {
			return dir
		}
	}
	return ""
}

// taskAt 只认运行时的两种目录形状：tasks/tN/repo 与代理的 repos/<clone>-tN。
func taskAt(dir string) string {
	dir = filepath.FromSlash(dir)
	name := filepath.Base(dir)
	if name == "repo" && filepath.Base(filepath.Dir(filepath.Dir(dir))) == "tasks" {
		name = filepath.Base(filepath.Dir(dir))
		if taskDirRE.FindString(name) == name && strings.HasPrefix(name, "t") {
			return name
		}
	}
	if filepath.Base(filepath.Dir(dir)) == "repos" {
		match := taskDirRE.FindString(name)
		if strings.HasPrefix(match, "-t") {
			return strings.TrimPrefix(match, "-")
		}
	}
	return ""
}
