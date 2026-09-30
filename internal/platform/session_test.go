package platform

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestSessionProcessHelper(t *testing.T) {
	mode := os.Getenv("ATRIUM_TEST_SESSION")
	if mode == "" {
		return
	}
	if mode == "child" {
		for {
			time.Sleep(time.Second)
		}
	}
	env := EnvMap(os.Environ())
	env["ATRIUM_TEST_SESSION"] = "child"
	cmd, err := Start(Spec{Path: os.Args[0], Args: []string{"-test.run=^TestSessionProcessHelper$"}, Env: env, Detached: true})
	if err != nil {
		os.Exit(2)
	}
	if err := os.WriteFile(os.Getenv("ATRIUM_TEST_PID"), []byte(strconv.Itoa(cmd.Process.Pid)), 0600); err != nil {
		os.Exit(3)
	}
	for {
		if _, err := os.Stat(os.Getenv("ATRIUM_TEST_RELEASE")); err == nil {
			os.Exit(0)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSessionCleanup(t *testing.T) {
	for _, stop := range []bool{false, true} {
		t.Run(fmt.Sprintf("stop=%v", stop), func(t *testing.T) {
			dir := t.TempDir()
			env := map[string]string{"ATRIUM_TEST_SESSION": "child"}
			outside, err := Start(Spec{Path: os.Args[0], Args: []string{"-test.run=^TestSessionProcessHelper$"}, Env: env, Detached: true})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { KillTree(outside.Process.Pid); outside.Wait() }()
			env = map[string]string{"ATRIUM_TEST_SESSION": "parent", "ATRIUM_TEST_PID": filepath.Join(dir, "pid"), "ATRIUM_TEST_RELEASE": filepath.Join(dir, "release")}
			cmd, err := Start(Spec{Path: os.Args[0], Args: []string{"-test.run=^TestSessionProcessHelper$"}, Env: env, Detached: true, Session: true})
			if err != nil {
				t.Fatal(err)
			}
			defer KillTree(cmd.Process.Pid)
			var child int
			deadline := time.Now().Add(5 * time.Second)
			for child == 0 && time.Now().Before(deadline) {
				data, _ := os.ReadFile(env["ATRIUM_TEST_PID"])
				child, _ = strconv.Atoi(string(data))
				time.Sleep(10 * time.Millisecond)
			}
			if child == 0 {
				t.Fatal("未收到独立进程组子进程 PID")
			}
			defer KillTree(child)
			if stop {
				if err := KillTree(cmd.Process.Pid); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.WriteFile(env["ATRIUM_TEST_RELEASE"], nil, 0600); err != nil {
					t.Fatal(err)
				}
			}
			done := make(chan error, 1)
			go func() { done <- WaitSession(cmd) }()
			select {
			case err := <-done:
				if !stop && err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("会话回收超时")
			}
			deadline = time.Now().Add(5 * time.Second)
			for processRunning(child) && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			if processRunning(child) {
				t.Fatal("独立进程组子进程仍存活")
			}
			if !Alive(outside.Process.Pid) {
				t.Fatal("误杀会话外进程")
			}
			t.Log("会话残留已回收，会话外进程仍存活")
		})
	}
}

func processRunning(pid int) bool {
	if !Alive(pid) {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	// Linux 的 PID 1 不一定及时回收孤儿僵尸；僵尸已结束，不能继续执行。
	out, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	return err == nil && !strings.HasPrefix(strings.TrimSpace(string(out)), "Z")
}

func TestSessionRequiresDetached(t *testing.T) {
	if _, err := Start(Spec{Path: os.Args[0], Env: map[string]string{}, Session: true}); err == nil {
		t.Fatal("Session 未隔离必须拒绝")
	}
}
