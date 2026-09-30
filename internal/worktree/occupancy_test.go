package worktree

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestOccupied(t *testing.T) {
	list := "worktree /主仓库\x00HEAD a\x00branch refs/heads/main\x00\x00worktree /中文\n目录/tasks/t642/repo\x00HEAD b\x00branch refs/heads/task-t476\x00\x00"
	if got := occupied(list, "task-t476"); got != "/中文\n目录/tasks/t642/repo" {
		t.Fatalf("目录解析：%q", got)
	}
	for _, branch := range []string{"task-t47", "task-t476-more", "missing"} {
		if got := occupied(list, branch); got != "" {
			t.Fatalf("误判分支 %s：%q", branch, got)
		}
	}
}

func TestTaskAt(t *testing.T) {
	for _, tc := range []struct{ path, want string }{
		{"data/tasks/t642/repo", "t642"},
		{"agent/repos/owner-repo-t642", "t642"},
		{"user/t642/repo", ""},
		{"data/tasks/other-t642/repo", ""},
		{"data/tasks/t0/repo", ""},
		{"agent/repos/owner-repo-t642-extra", ""},
	} {
		if got := taskAt(filepath.FromSlash(tc.path)); got != tc.want {
			t.Fatalf("%s：%s，想要 %s", tc.path, got, tc.want)
		}
	}
}

func TestAvailableUnknownOwnerAndQueryError(t *testing.T) {
	run := func(context.Context, string, string, ...string) (string, error) {
		return "worktree /external\x00branch refs/heads/task-t1\x00\x00", nil
	}
	if err := Available(context.Background(), "clone", "task-t1", run); err == nil || !strings.Contains(err.Error(), "无法确认任务") {
		t.Fatalf("未知占用者：%v", err)
	}
	fault := errors.New("git 查询失败")
	run = func(context.Context, string, string, ...string) (string, error) { return "", fault }
	if err := Available(context.Background(), "clone", "task-t1", run); !errors.Is(err, fault) {
		t.Fatalf("查询失败被忽略：%v", err)
	}
}
