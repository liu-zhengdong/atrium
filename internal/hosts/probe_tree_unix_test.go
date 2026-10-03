//go:build !windows

package hosts

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/platform"
)

func TestVersionReclaimsChildren(t *testing.T) {
	old := probeTimeout
	defer func() { probeTimeout = old }()
	for _, mode := range []string{"normal", "failure", "timeout", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			pidFile := filepath.Join(dir, "pid")
			script := filepath.Join(dir, "tool")
			end := "exit 0"
			if mode == "failure" {
				end = "exit 7"
			}
			if mode == "timeout" || mode == "cancel" {
				end = "wait"
			}
			if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 30 &\necho $! > \"$PID_FILE\"\n"+end+"\n"), 0700); err != nil {
				t.Fatal(err)
			}
			env := map[string]string{"PATH": "/usr/bin:/bin", "PID_FILE": pidFile}
			outsideSpec := platform.Shell("sleep 30")
			outsideSpec.Env = env
			outsideSpec.Detached = true
			outside, err := platform.Start(outsideSpec)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { platform.KillTree(outside.Process.Pid); outside.Wait() }()
			probeTimeout = 3 * time.Second
			if mode == "timeout" || mode == "cancel" {
				probeTimeout = 500 * time.Millisecond
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancel" {
				go func() {
					for {
						if _, err := os.Stat(pidFile); err == nil {
							cancel()
							return
						}
						select {
						case <-ctx.Done():
							return
						case <-time.After(5 * time.Millisecond):
						}
					}
				}()
			}
			r := runVersion(ctx, script, env)
			if r.Err != "" || (mode == "normal" && (r.Code != 0 || r.TimedOut)) || (mode == "failure" && (r.Code != 7 || r.TimedOut)) || ((mode == "timeout" || mode == "cancel") && !r.TimedOut) {
				t.Fatalf("结果：%+v", r)
			}
			data, err := os.ReadFile(pidFile)
			if err != nil {
				t.Fatal(err)
			}
			pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				p, err := os.FindProcess(pid)
				if err == nil {
					p.Kill()
				}
			}()
			// Unix 僵尸已停止执行，等待系统收养者收割不属于本次回收。
			deadline := time.Now().Add(2 * time.Second)
			for platform.Alive(pid) && time.Now().Before(deadline) {
				p := platform.Shell("ps -o stat= -p " + strconv.Itoa(pid))
				p.Env = env
				var out strings.Builder
				p.Stdout = &out
				cmd, err := platform.Start(p)
				if err != nil {
					t.Fatal(err)
				}
				cmd.Wait()
				if strings.HasPrefix(strings.TrimSpace(out.String()), "Z") {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			p := platform.Shell("ps -o stat= -p " + strconv.Itoa(pid))
			p.Env = env
			var out strings.Builder
			p.Stdout = &out
			cmd, err := platform.Start(p)
			if err != nil {
				t.Fatal(err)
			}
			cmd.Wait()
			if stat := strings.TrimSpace(out.String()); stat != "" && !strings.HasPrefix(stat, "Z") {
				t.Fatalf("子进程仍活着：%s", stat)
			}
			if !platform.Alive(outside.Process.Pid) {
				t.Fatal("误杀树外进程")
			}
		})
	}
}
