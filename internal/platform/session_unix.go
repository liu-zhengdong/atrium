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
// 只在结束时取一次进程快照。pid 只有 Windows 用。
func EndSession(_ int, dir string) error {
	if dir == "" {
		return nil
	}
	args := []string{"axeww", "-o", "pid=,command="}
	if runtime.GOOS == "darwin" {
		args = []string{"axEww", "-o", "pid=,command="}
	}
	out, err := exec.Command("ps", args...).Output()
	if err != nil {
		return fmt.Errorf("读取会话进程：%w", err)
	}
	var result error
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
