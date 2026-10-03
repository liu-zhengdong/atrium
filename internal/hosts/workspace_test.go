package hosts

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAgentWorkspaceBranchOwnership(t *testing.T) {
	root := isolatedGit(t)
	seed := filepath.Join(root, "seed")
	gitRun(t, "", "init", "--quiet", "-b", "main", seed)
	gitRun(t, seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "初始")
	a := NewAgent(filepath.Join(root, "agent"), AgentConfig{}, nil)
	if err := os.MkdirAll(filepath.Join(a.Dir, "repos"), 0700); err != nil {
		t.Fatal(err)
	}
	as := Assignment{Task: "t1", Repo: seed, Branch: "task-t1", Base: "main"}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dir, err := a.worktree(ctx, as)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := a.worktree(ctx, as); err != nil || again != dir {
		t.Fatalf("原任务不能续用：%s %v", again, err)
	}
	gitRun(t, dir, "checkout", "--quiet", "-b", "task-t2")
	if _, err := a.worktree(ctx, as); err == nil || !strings.Contains(err.Error(), "不是 task-t1") {
		t.Fatalf("误用其他分支：%v", err)
	}
	// 模拟另一个任务持有原分支，原任务重建时必须报错，不接管它。
	gitRun(t, filepath.Join(a.Dir, "repos", CloneName(seed)), "worktree", "remove", dir)
	clone := filepath.Join(a.Dir, "repos", CloneName(seed))
	other := clone + "-t642"
	gitRun(t, clone, "worktree", "add", "--quiet", other, "task-t1")
	if _, err := a.worktree(ctx, as); err == nil || !strings.Contains(err.Error(), "t642") || !strings.Contains(err.Error(), "拉起前停止") {
		t.Fatalf("代理未报告占用者：%v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("误删占用者：%v", err)
	}
}

// 工作树路径已存在但是空目录，上级又恰好在任务分支上：不能把上级当成这次检出。
func TestWorktreeEmptyDirDoesNotUseParent(t *testing.T) {
	root := isolatedGit(t)
	seed := filepath.Join(root, "seed")
	gitRun(t, "", "init", "--quiet", "-b", "main", seed)
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, seed, "add", "README.md")
	gitRun(t, seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "初始")
	a := NewAgent(filepath.Join(root, "agent"), AgentConfig{}, nil)
	gitRun(t, "", "init", "--quiet", "-b", "task-t1", a.Dir)
	gitRun(t, a.Dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "parent")
	before := gitOut(t, a.Dir, "rev-parse", "HEAD")
	wt := filepath.Join(a.Dir, "repos", CloneName(seed)) + "-t1"
	if err := os.MkdirAll(wt, 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dir, err := a.worktree(ctx, Assignment{Task: "t1", Repo: seed, Branch: "task-t1", Base: "main"})
	if err != nil {
		t.Fatal(err)
	}
	if dir != wt {
		t.Fatalf("工作树 %s", dir)
	}
	assertTop(t, dir)
	if body, err := os.ReadFile(filepath.Join(dir, "README.md")); err != nil || string(body) != "hi\n" {
		t.Fatalf("没有检出任务仓库：%q %v", body, err)
	}
	if head := gitOut(t, a.Dir, "rev-parse", "HEAD"); head != before {
		t.Fatalf("改了上级仓库：%s", head)
	}
}

func TestPlainWorkSealsOwnTop(t *testing.T) {
	root := isolatedGit(t)
	a := NewAgent(filepath.Join(root, "agent"), AgentConfig{}, nil)
	parent := filepath.Join(a.Dir, "tasks", "t1")
	gitRun(t, "", "init", "--quiet", "-b", "main", parent)
	gitRun(t, parent, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "parent")
	before := gitOut(t, parent, "rev-parse", "HEAD")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dir, err := a.plainWork(ctx, "t1")
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Join(parent, "work") {
		t.Fatalf("工作目录 %s", dir)
	}
	assertTop(t, dir)
	if head := gitOut(t, parent, "rev-parse", "HEAD"); head != before {
		t.Fatalf("改了上级仓库：%s", head)
	}
}

// isolatedGit 给测试和代理一份固定的 Git 配置。代理跑 git 用 WorkerEnv，GIT_CONFIG_* 会被滤掉、HOME 保留，
// 所以写在临时 HOME 的 .gitconfig 里：全局配置盖过系统配置（如 Windows 的 core.autocrlf=true）。
func isolatedGit(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	config := filepath.Join(root, ".gitconfig")
	if err := os.WriteFile(config, []byte("[core]\n\tautocrlf = false\n[user]\n\tname = t\n\temail = t@t\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", root)
	t.Setenv("USERPROFILE", root)
	t.Setenv("GIT_CONFIG_GLOBAL", config)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	return root
}

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	if dir != "" {
		args = append([]string{"-C", dir}, args...)
	}
	out, err := exec.Command("git", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v：%v %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func assertTop(t *testing.T, dir string) {
	t.Helper()
	top := gitOut(t, dir, "rev-parse", "--show-toplevel")
	got, err := filepath.EvalSymlinks(top)
	if err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("顶层 %s，目录 %s", got, want)
	}
}

// 生产 workspaceRun 原样返回标准输出（与 dispatch.run 同一契约）。
func TestWorkspaceRunReturnsVerbatimOutput(t *testing.T) {
	isolatedGit(t)
	a := NewAgent(t.TempDir(), AgentConfig{}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	out, err := a.workspaceRun(ctx, "", "git", "--version")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(out, "\n") {
		t.Fatalf("workspaceRun 应原样返回标准输出，实际 %q", out)
	}
}
