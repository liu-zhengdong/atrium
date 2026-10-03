//go:build !windows

package platform

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// Detached 用新会话（setsid）：脱离终端，进程组号 = pid，结束时给整个组发信号。cmdLine 只有 Windows 用。
func sysProcAttr(detached bool, _ string) *syscall.SysProcAttr {
	if detached {
		return &syscall.SysProcAttr{Setsid: true}
	}
	return nil
}

func adopt(int, bool) error { return nil } // 进程组在拉起时已由 setsid 建好

func killJob(int) (bool, error) { return false, nil }

func killGroup(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("进程组 pid 必须大于 0：%d", pid)
	}
	err := syscall.Kill(-pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func isExecutable(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir() && st.Mode()&0o111 != 0
}
