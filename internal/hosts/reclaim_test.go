package hosts

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/workers"
)

func TestReclaimRefusal(t *testing.T) {
	root := t.TempDir()
	for _, tc := range []struct {
		name, task, dir string
		allowed         bool
	}{
		{"本任务", "t1", filepath.Join(root, "repos", "owner-repo-t1"), true},
		{"其他任务", "t2", filepath.Join(root, "repos", "owner-repo-t1"), false},
		{"其他目录", "t1", filepath.Join(root, "user-repo-t1"), false},
		{"嵌套目录", "t1", filepath.Join(root, "repos", "nested", "repo-t1"), false},
		{"相对目录", "t1", "repos/repo-t1", false},
		{"穿越短号", "../t1", filepath.Join(root, "repos", "repo-t1"), false},
		{"没有克隆名", "t1", filepath.Join(root, "repos", "-t1"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ReclaimRefusal(root, ReclaimRequest{Task: tc.task, Dir: tc.dir}); (got == "") != tc.allowed {
				t.Fatalf("拒绝原因：%s", got)
			}
		})
	}
}

// 临时 HTTP 服务与真代理协议、真 Git、本地 bare 远端，执行者是测试二进制。
func TestAgentReclaimAndRebuild(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("USERPROFILE", root)
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(root, "gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	origin := filepath.Join(root, "origin.git")
	seed := filepath.Join(root, "seed")
	gitRun(t, "", "init", "--quiet", "--bare", "-b", "main", origin)
	gitRun(t, "", "init", "--quiet", "-b", "main", seed)
	if err := os.WriteFile(filepath.Join(seed, "README"), []byte("初始"), 0600); err != nil {
		t.Fatal(err)
	}
	gitRun(t, seed, "add", "README")
	gitRun(t, seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "初始")
	gitRun(t, seed, "push", "--quiet", origin, "main")
	g := newRig(t)
	g.task("t1")
	a, cancel, done := g.agent(filepath.Join(root, "agent"))
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("代理没停")
		}
	})
	ctx, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	as := Assignment{Task: "t1", Tool: "echo", Repo: origin, Branch: "task-t1", Base: "main", Request: workers.Request{Prompt: "回收验证"}, Log: filepath.Join(g.env.Paths.Data, "task.log")}
	run, _, dir, err := Launch(ctx, g.env, a.Cfg.Host, as)
	if err != nil {
		t.Fatal(err)
	}
	waitExit(t, g.env, "t1", run)
	if err := os.MkdirAll(filepath.Join(dir, "node_modules"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "node_modules", "cache"), []byte("依赖"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "result.txt"), []byte("已推送"), 0600); err != nil {
		t.Fatal(err)
	}
	gitRun(t, dir, "add", "result.txt")
	gitRun(t, dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "交付")
	gitRun(t, dir, "push", "--quiet", "origin", "task-t1")
	if err := Reclaim(ctx, a.Cfg.Host, ReclaimRequest{Task: "t1", Dir: dir, Run: run}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("远程工作树还在：%v", err)
	}
	clone := filepath.Join(a.Dir, "repos", CloneName(origin))
	if out, err := a.workspaceRun(ctx, clone, "git", "branch", "--list", "task-t1"); err != nil || out != "" {
		t.Fatalf("远程分支还在：%s %v", out, err)
	}
	if err := Reclaim(ctx, a.Cfg.Host, ReclaimRequest{Task: "t1", Dir: dir, Run: run}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"prompt-1.md", "run-1.log"} {
		if _, err := os.Stat(filepath.Join(a.Dir, "tasks", "t1", name)); err != nil {
			t.Fatal(err)
		}
	}
	run, _, rebuilt, err := Launch(ctx, g.env, a.Cfg.Host, as)
	if err != nil {
		t.Fatal(err)
	}
	waitExit(t, g.env, "t1", run)
	if err := Reclaim(ctx, a.Cfg.Host, ReclaimRequest{Task: "t1", Dir: rebuilt, Run: run - 1}); err == nil {
		t.Fatal("旧回收指令不应删重开后的工作树")
	}
	if b, err := os.ReadFile(filepath.Join(rebuilt, "result.txt")); err != nil || string(b) != "已推送" {
		t.Fatalf("远程重建丢改动：%s %v", b, err)
	}
	t.Log("远程代理已回收工作树与分支，保留 prompt/run，第二轮实际执行者已在重建工作树退出")
}
