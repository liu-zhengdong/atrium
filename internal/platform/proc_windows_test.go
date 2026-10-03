package platform

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 进程退出后 Job 句柄经完成端口关掉，不留在记录里。
func TestJobReleasedAfterExit(t *testing.T) {
	spec := Shell("exit 0")
	spec.Env, spec.Detached = WorkerEnv(runtime.GOOS, EnvMap(os.Environ())), true
	cmd, err := Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	cmd.Wait()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		jobs.Lock()
		_, held := jobs.byID[pid]
		jobs.Unlock()
		if !held {
			return
		}
	}
	t.Fatal("进程退出后 Job 句柄还记着")
}

// owner 退出模拟代理重启：任务继续，随后主体退出时最后一个 Job 句柄关闭，孙进程被回收。
func TestManagedJobSurvivesOwnerThenCloses(t *testing.T) {
	dir := t.TempDir()
	env := map[string]string{"ATRIUM_TEST_TREE": "owner", "ATRIUM_TEST_TREE_ROOT": filepath.Join(dir, "root"), "ATRIUM_TEST_TREE_PIDS": filepath.Join(dir, "pids"), "ATRIUM_TEST_TREE_RELEASE": filepath.Join(dir, "release")}
	owner, err := Start(Spec{Path: os.Args[0], Args: []string{"-test.run=^TestTreeHelper$"}, Env: env, Detached: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := owner.Wait(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(env["ATRIUM_TEST_TREE_ROOT"])
	if err != nil {
		t.Fatal(err)
	}
	root, err := strconv.Atoi(string(data))
	if err != nil {
		t.Fatal(err)
	}
	defer KillTree(root)
	var pids []int
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		data, _ := os.ReadFile(env["ATRIUM_TEST_TREE_PIDS"])
		if fields := strings.Fields(string(data)); len(fields) == 2 {
			for _, f := range fields {
				n, _ := strconv.Atoi(f)
				pids = append(pids, n)
			}
			break
		}
	}
	if len(pids) != 2 || !Alive(root) {
		t.Fatal("代理退出后任务未继续")
	}
	for _, pid := range pids {
		if !Alive(pid) {
			t.Fatal("子孙提前退出")
		}
		defer func(pid int) {
			p, _ := os.FindProcess(pid)
			if p != nil {
				p.Kill()
			}
		}(pid)
	}
	if err := os.WriteFile(env["ATRIUM_TEST_TREE_RELEASE"], []byte("0"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, pid := range append(pids, root) {
		for deadline := time.Now().Add(5 * time.Second); Alive(pid) && time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		}
		if Alive(pid) {
			t.Fatalf("最后句柄关闭后 %d 仍活着", pid)
		}
	}
}
