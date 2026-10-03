//go:build !windows

package platform

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"syscall"
)

// EndSession 结束命令行或环境引用会话临时目录 dir 的进程（主体已退出后调用；重启后按 pid 跟进的路径同样调用）。
// 先回收 pid 的原进程组，再取一次快照回收另开会话的残留。
func EndSession(pid int, dir string) error {
	// 先结束原进程组：即使子孙清空环境、没有临时目录参数，也能回收。
	groupErr := killGroup(pid)
	if dir == "" {
		return groupErr
	}
	args := []string{"axeww", "-o", "pid=,command="}
	if runtime.GOOS == "darwin" {
		args = []string{"axEww", "-o", "pid=,command="}
	}
	out, err := exec.Command("ps", args...).Output()
	if err != nil {
		return errors.Join(groupErr, fmt.Errorf("读取会话进程：%w", err))
	}
	result := groupErr
	for _, pid := range sessionPIDs(string(out), dir) {
		if pid == os.Getpid() {
			continue
		}
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			result = errors.Join(result, err)
		}
	}
	return result
}
