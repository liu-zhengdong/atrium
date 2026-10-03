package platform

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// 真拉起一棵进程树（sh → 两个 sleep，一个在后台），KillTree 后整棵树都不在：子孙握着输出管道，Wait 能返回才算都结束了。
// Windows 上 Git for Windows 的 sh 模拟 fork/exec，sleep 的父进程已退出，taskkill /T 找不到它（t366）。
func TestStartDetachedAndKillTree(t *testing.T) {
	script := filepath.Join(t.TempDir(), "tree")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 30 &\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	spec, err := Script(script, WorkerEnv(runtime.GOOS, EnvMap(os.Environ())))
	if err != nil {
		t.Fatal(err)
	}
	spec.Stdout, spec.Detached = &bytes.Buffer{}, true
	cmd, err := Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	if !Alive(pid) {
		t.Fatal("刚拉起就不在了")
	}
	time.Sleep(500 * time.Millisecond) // 等 sleep 都拉起来
	if err := KillTree(pid); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("KillTree 后还有子孙进程握着输出")
	}
	if Alive(pid) {
		t.Fatal("KillTree 后进程还在")
	}
	if _, err := Start(Spec{Path: "/bin/sh"}); err == nil {
		t.Fatal("不给 Env 应拒绝")
	}
}

// 工作目录已被删除时报工作目录。Detached（设了 SysProcAttr）时 Go 不预先查目录，原样报的是
// 「fork/exec <程序>: no such file or directory」，像是程序不存在（t946 卡在 gate，t962）。
func TestStartReportsMissingDir(t *testing.T) {
	for _, detached := range []bool{false, true} {
		dir := t.TempDir()
		script := filepath.Join(dir, "ok")
		if err := os.WriteFile(script, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		spec, err := Script(script, WorkerEnv(runtime.GOOS, EnvMap(os.Environ())))
		if err != nil {
			t.Fatal(err)
		}
		spec.Detached = detached

		spec.Dir = dir
		cmd, err := Start(spec)
		if err != nil {
			t.Fatalf("detached=%v：目录存在时应能拉起：%v", detached, err)
		}
		if err := cmd.Wait(); err != nil {
			t.Fatal(err)
		}

		missing := filepath.Join(dir, "gone")
		spec.Dir = missing
		_, err = Start(spec)
		if err == nil || !strings.Contains(err.Error(), "工作目录") || !strings.Contains(err.Error(), missing) {
			t.Fatalf("detached=%v：目录不存在应报工作目录 %s，实际：%v", detached, missing, err)
		}

		spec.Dir, spec.Path = dir, filepath.Join(dir, "no-such-program")
		_, err = Start(spec)
		if err == nil || strings.Contains(err.Error(), "工作目录") {
			t.Fatalf("detached=%v：目录存在而程序不存在应原样报错，实际：%v", detached, err)
		}
	}
}

// sh 的输出经 OpenLog 接在已有内容后面。Windows 上以 O_APPEND 打开的句柄 sh 写不进去（t499）。
func TestOpenLogTakesShOutput(t *testing.T) {
	dir := t.TempDir()
	script, log := filepath.Join(dir, "hi"), filepath.Join(dir, "run.log")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho hi\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(log, []byte("head\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	spec, err := Script(script, WorkerEnv(runtime.GOOS, EnvMap(os.Environ())))
	if err != nil {
		t.Fatal(err)
	}
	f, err := OpenLog(log)
	if err != nil {
		t.Fatal(err)
	}
	spec.Stdout, spec.Stderr = f, f
	cmd, err := Start(spec)
	if err == nil {
		err = cmd.Wait()
	}
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(log); string(got) != "head\nhi\n" {
		t.Fatalf("日志 %q", got)
	}
}

func TestLookPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip()
	}
	env := map[string]string{"PATH": "/nonexistent:/bin:/usr/bin"}
	p, err := LookPath("sh", env)
	if err != nil || p == "" {
		t.Fatalf("got %q %v", p, err)
	}
	if _, err := LookPath("definitely-not-a-binary-xyz", env); err == nil {
		t.Fatal("应找不到")
	}
}
