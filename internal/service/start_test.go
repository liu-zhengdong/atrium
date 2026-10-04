package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/platform"
)

func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "serve" {
		// 测试用：把子进程 cwd 写出去，供断言 spawn 后的工作目录（ATRIUM_ 前缀能过 ServiceEnv 白名单）。
		if out := os.Getenv("ATRIUM_TEST_CWD_OUT"); out != "" {
			if wd, err := os.Getwd(); err == nil {
				_ = os.WriteFile(out, []byte(wd), 0o600)
			}
		}
		if err := Serve(nil, os.Getenv); err != nil {
			println(err.Error())
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestStartExit(t *testing.T) {
	p := config.Paths{Data: t.TempDir()}
	if err := os.WriteFile(p.Log(), []byte("旧启动错误\n"), 0600); err != nil {
		t.Fatal(err)
	}
	env := platform.EnvMap(os.Environ())
	env["ATRIUM_PORT"] = "70000"
	pid, _, exited, err := spawnServe(p, env, 0)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	_, err = waitUp(p, pid, 10*time.Second, exited)
	if err == nil || !strings.Contains(err.Error(), `ATRIUM_PORT 应为 0–65535 的整数，收到 "70000"`) || strings.Contains(err.Error(), "旧启动错误") {
		t.Fatalf("错误原文或本次日志边界不正确：%v", err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("退出后仍等待 %s", elapsed)
	}
}

func TestStartAutomaticPort(t *testing.T) {
	p := config.Paths{Data: t.TempDir()}
	env := platform.EnvMap(os.Environ())
	env["ATRIUM_PORT"] = "0"
	pid, _, exited, err := spawnServe(p, env, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := platform.KillTree(pid); err != nil {
			t.Error(err)
		}
		select {
		case <-exited:
		case <-time.After(3 * time.Second):
			t.Error("子进程未退出")
		}
	})
	info, err := waitUp(p, pid, 10*time.Second, exited)
	if err != nil {
		t.Fatal(err)
	}
	if info.Port < 1 || probe(info.Port) != pid {
		t.Fatalf("服务未在自动端口就绪：%+v", info)
	}
}

// 子进程的工作目录必须是数据目录：拉起者的目录可能已被删（任务目录回收），
// 继承过去 shell 与 mise 都会 getcwd 失败。
func TestSpawnCWDIsDataDir(t *testing.T) {
	p := config.Paths{Data: t.TempDir()}
	out := filepath.Join(t.TempDir(), "cwd")
	env := platform.EnvMap(os.Environ())
	env["ATRIUM_PORT"] = "0"
	env["ATRIUM_TEST_CWD_OUT"] = out
	pid, _, exited, err := spawnServe(p, env, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := platform.KillTree(pid); err != nil {
			t.Error(err)
		}
		select {
		case <-exited:
		case <-time.After(3 * time.Second):
			t.Error("子进程未退出")
		}
	})
	if _, err := waitUp(p, pid, 10*time.Second, exited); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("子进程没写出 cwd：%v", err)
	}
	// macOS 上 TempDir 走 /var 符号链接，两边都归一化后再比。
	want, err := filepath.EvalSymlinks(p.Data)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(raw)); got != want {
		t.Fatalf("子进程 cwd = %s，期望数据目录 %s", got, want)
	}
}
