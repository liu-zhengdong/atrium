package service

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/platform"
)

func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "serve" {
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
