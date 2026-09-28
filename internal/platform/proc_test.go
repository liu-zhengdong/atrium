package platform

import (
	"os"
	"runtime"
	"testing"
	"time"
)

// 真拉起一棵进程树（sh → sleep），KillTree 后两者都不在。
func TestStartDetachedAndKillTree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 由远端 CI 覆盖")
	}
	env := WorkerEnv(runtime.GOOS, EnvMap(os.Environ()))
	spec := Shell("sleep 30 & echo $! ; wait")
	spec.Env = env
	spec.Detached = true
	cmd, err := Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	if !Alive(pid) {
		t.Fatal("刚拉起就不在了")
	}
	if err := KillTree(pid); err != nil {
		t.Fatal(err)
	}
	cmd.Wait()
	deadline := time.Now().Add(2 * time.Second)
	for Alive(pid) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if Alive(pid) {
		t.Fatal("KillTree 后进程还在")
	}
	if _, err := Start(Spec{Path: "/bin/sh"}); err == nil {
		t.Fatal("不给 Env 应拒绝")
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
