package platform

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 全部进程用测试二进制，不依赖 shell、真实工具或主目录配置。
func TestTreeHelper(t *testing.T) {
	mode := os.Getenv("ATRIUM_TEST_TREE")
	if mode == "" {
		return
	}
	if mode == "leaf" {
		for {
			time.Sleep(time.Second)
		}
	}
	env := EnvMap(os.Environ())
	if mode == "owner" {
		env["ATRIUM_TEST_TREE"] = "parent"
		root, err := Start(Spec{Path: os.Args[0], Args: []string{"-test.run=^TestTreeHelper$"}, Env: env, Detached: true, ManagedTree: true})
		if err != nil {
			os.Exit(2)
		}
		if err := os.WriteFile(env["ATRIUM_TEST_TREE_ROOT"], []byte(strconv.Itoa(root.Process.Pid)), 0600); err != nil {
			os.Exit(3)
		}
		os.Exit(0)
	}
	next := "branch"
	if mode == "branch" {
		next = "leaf"
	}
	env["ATRIUM_TEST_TREE"] = next
	child := exec.Command(os.Args[0], "-test.run=^TestTreeHelper$")
	child.Env = EnvList(env)
	// 故意继承输出管道，检验主体结束后 Wait 不会永远等子孙。
	child.Stdout, child.Stderr = os.Stdout, os.Stderr
	if err := child.Start(); err != nil {
		os.Exit(2)
	}
	if mode == "branch" {
		os.WriteFile(os.Getenv("ATRIUM_TEST_TREE_PIDS"), []byte(fmt.Sprintf("%d %d", os.Getpid(), child.Process.Pid)), 0600)
		for {
			time.Sleep(time.Second)
		}
	}
	for {
		if b, err := os.ReadFile(os.Getenv("ATRIUM_TEST_TREE_RELEASE")); err == nil {
			n, _ := strconv.Atoi(string(b))
			os.Exit(n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestManagedTreeCleanup(t *testing.T) {
	for _, mode := range []string{"normal", "failure", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			env := map[string]string{"ATRIUM_TEST_TREE": "parent", "ATRIUM_TEST_TREE_PIDS": filepath.Join(dir, "pids"), "ATRIUM_TEST_TREE_RELEASE": filepath.Join(dir, "release")}
			outsideEnv := map[string]string{"ATRIUM_TEST_TREE": "leaf"}
			outside, err := Start(Spec{Path: os.Args[0], Args: []string{"-test.run=^TestTreeHelper$"}, Env: outsideEnv, Detached: true})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { KillTree(outside.Process.Pid); outside.Wait() }()
			cmd, err := Start(Spec{Path: os.Args[0], Args: []string{"-test.run=^TestTreeHelper$"}, Env: env, Detached: true, ManagedTree: true, Stdout: &strings.Builder{}})
			if err != nil {
				t.Fatal(err)
			}
			defer KillTree(cmd.Process.Pid)
			var pids []int
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				b, _ := os.ReadFile(env["ATRIUM_TEST_TREE_PIDS"])
				if f := strings.Fields(string(b)); len(f) == 2 {
					for _, s := range f {
						n, _ := strconv.Atoi(s)
						pids = append(pids, n)
					}
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if len(pids) != 2 {
				t.Fatal("未收到子孙 PID")
			}
			for _, pid := range pids {
				defer func(pid int) {
					if processRunning(pid) {
						p, err := os.FindProcess(pid)
						if err == nil {
							p.Kill()
						}
					}
				}(pid)
			}
			done := make(chan error, 1)
			go func() { done <- WaitSession(cmd, "") }()
			if mode == "timeout" {
				if err := KillTree(cmd.Process.Pid); err != nil {
					t.Fatal(err)
				}
			} else {
				code := "0"
				if mode == "failure" {
					code = "7"
				}
				if err := os.WriteFile(env["ATRIUM_TEST_TREE_RELEASE"], []byte(code), 0600); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-done:
				if mode == "normal" && err != nil {
					t.Fatal(err)
				}
				if mode == "failure" && cmd.ProcessState.ExitCode() != 7 {
					t.Fatalf("退出码：%v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("回收未结束")
			}
			for _, pid := range pids {
				deadline = time.Now().Add(5 * time.Second)
				for processRunning(pid) && time.Now().Before(deadline) {
					time.Sleep(10 * time.Millisecond)
				}
				if processRunning(pid) {
					t.Fatalf("子孙 %d 仍活着", pid)
				}
			}
			if !processRunning(outside.Process.Pid) {
				t.Fatal("误杀树外进程")
			}
		})
	}
}
