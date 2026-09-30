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

func TestSessionPIDs(t *testing.T) {
	dir := "/data/tasks/t1/tmp"
	ps := strings.Join([]string{
		" 101 claude -p HOME=/x TMPDIR=" + dir + " PATH=/bin",                        // 环境继承
		" 102 chrome --headless --user-data-dir=" + dir + "/puppeteer_dev_profile-1", // 参数引用
		" 103 sh " + dir,
		" 104 sh TMPDIR=/data/tasks/t10/tmp",
		" 105 sh TMPDIR=/data/tasks/t1/tmpx",
		" 106 sh TMPDIR=/other/data/tasks/t1/tmp",
		" 107 sh",
		"abc sh TMPDIR=" + dir,
		"",
	}, "\n")
	if got := fmt.Sprint(sessionPIDs(ps, dir)); got != "[101 102 103]" {
		t.Fatalf("sessionPIDs = %s", got)
	}
	if got := sessionPIDs(ps, ""); got != nil {
		t.Fatalf("空目录不能匹配：%v", got)
	}
}

// TestSessionProcessHelper 是测试拉起的假进程：child 一直睡；parent 另开会话起两个子进程后等放行退出——
// 一个继承环境，一个清掉临时目录变量、只在参数里引用会话临时目录（像 Chrome 的 --user-data-dir）。
func TestSessionProcessHelper(t *testing.T) {
	switch os.Getenv("ATRIUM_TEST_SESSION") {
	case "":
		return
	case "child":
		for {
			time.Sleep(time.Second)
		}
	}
	env := EnvMap(os.Environ())
	env["ATRIUM_TEST_SESSION"] = "child"
	inherit, err := Start(Spec{Path: os.Args[0], Args: []string{"-test.run=^TestSessionProcessHelper$"}, Env: env, Detached: true})
	if err != nil {
		os.Exit(2)
	}
	tmp := env[EnvKey(runtime.GOOS, "TMPDIR")]
	for _, k := range []string{"TMPDIR", "TMP", "TEMP"} {
		delete(env, EnvKey(runtime.GOOS, k))
	}
	byArg, err := Start(Spec{Path: os.Args[0], Args: []string{"-test.run=^TestSessionProcessHelper$", "--", "--user-data-dir=" + filepath.Join(tmp, "profile")}, Env: env, Detached: true})
	if err != nil {
		os.Exit(2)
	}
	pids := fmt.Sprintf("%d %d", inherit.Process.Pid, byArg.Process.Pid)
	if err := os.WriteFile(os.Getenv("ATRIUM_TEST_PID"), []byte(pids), 0600); err != nil {
		os.Exit(3)
	}
	for {
		if _, err := os.Stat(os.Getenv("ATRIUM_TEST_RELEASE")); err == nil {
			os.Exit(0)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestSessionCleanup：exit 由 WaitSession 回收，stop 先结束主体，adopt 模拟服务重启后只按 pid 跟进、看到退出再 EndSession。
// 会话外进程与另一实例同名任务的会话进程都不能误杀。
func TestSessionCleanup(t *testing.T) {
	for _, mode := range []string{"exit", "stop", "adopt"} {
		t.Run(mode, func(t *testing.T) {
			base := t.TempDir()
			session := filepath.Join(base, "data", "tasks", "t1", "tmp")
			helper := func(env map[string]string) *exec.Cmd {
				cmd, err := Start(Spec{Path: os.Args[0], Args: []string{"-test.run=^TestSessionProcessHelper$"}, Env: env, Detached: true})
				if err != nil {
					t.Fatal(err)
				}
				return cmd
			}
			outside := helper(map[string]string{"ATRIUM_TEST_SESSION": "child"})
			defer func() { KillTree(outside.Process.Pid); outside.Wait() }()
			otherEnv := WorkerEnv(runtime.GOOS, map[string]string{}, filepath.Join(base, "other", "tasks", "t1", "tmp"))
			otherEnv["ATRIUM_TEST_SESSION"] = "child"
			other := helper(otherEnv)
			defer func() { KillTree(other.Process.Pid); other.Wait() }()
			env := WorkerEnv(runtime.GOOS, map[string]string{}, session)
			env["ATRIUM_TEST_SESSION"], env["ATRIUM_TEST_PID"], env["ATRIUM_TEST_RELEASE"] = "parent", filepath.Join(base, "pid"), filepath.Join(base, "release")
			cmd := helper(env)
			defer KillTree(cmd.Process.Pid)
			var children []int
			deadline := time.Now().Add(5 * time.Second)
			for len(children) < 2 && time.Now().Before(deadline) {
				data, _ := os.ReadFile(env["ATRIUM_TEST_PID"])
				children = children[:0]
				for _, f := range strings.Fields(string(data)) {
					n, _ := strconv.Atoi(f)
					children = append(children, n)
				}
				time.Sleep(10 * time.Millisecond)
			}
			if len(children) < 2 {
				t.Fatal("未收到另开会话的子进程 PID")
			}
			for _, c := range children {
				defer KillTree(c)
			}
			if mode == "stop" {
				if err := KillTree(cmd.Process.Pid); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(env["ATRIUM_TEST_RELEASE"], nil, 0600); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			if mode == "adopt" {
				go func() {
					cmd.Wait() // 只等主体，不经 WaitSession：拉起它的进程已经不在了
					for _, c := range children {
						if !processRunning(c) {
							done <- fmt.Errorf("主体退出时子进程 %d 已不在，没测到回收", c)
							return
						}
					}
					done <- EndSession(cmd.Process.Pid, session)
				}()
			} else {
				go func() { done <- WaitSession(cmd, session) }()
			}
			select {
			case err := <-done:
				if mode != "stop" && err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("会话回收超时")
			}
			for _, c := range children {
				deadline = time.Now().Add(5 * time.Second)
				for processRunning(c) && time.Now().Before(deadline) {
					time.Sleep(10 * time.Millisecond)
				}
				if processRunning(c) {
					t.Fatalf("另开会话的子进程 %d 仍存活", c)
				}
			}
			if !processRunning(outside.Process.Pid) || !processRunning(other.Process.Pid) {
				t.Fatal("误杀会话外进程")
			}
		})
	}
}

// processRunning 比 Alive 严：本测试拉起、还没 Wait 的进程被杀后是僵尸，Alive 仍报活。
func processRunning(pid int) bool {
	if !Alive(pid) {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	out, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	return err == nil && !strings.HasPrefix(strings.TrimSpace(string(out)), "Z")
}
