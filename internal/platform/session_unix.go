//go:build !windows

package platform

import (
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// 环境标记跨进程组、setsid 和父进程退出继承。只在会话结束时做一次快照，
// 不扫描名称、目录或用户应用；主动清空环境的进程不在此机制覆盖范围内。
func killSession(pid int) error {
	token, known := sessions.Load(pid)
	if !known {
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
	rows := strings.Split(string(out), "\n")
	marker := sessionKey + "=" + token.(string)
	var result error
	for _, row := range rows {
		fields := strings.Fields(row)
		if len(fields) < 2 {
			continue
		}
		for _, field := range fields[1:] {
			if field != marker {
				continue
			}
			child, err := strconv.Atoi(fields[0])
			if err != nil || child <= 0 || child == pid {
				break
			}
			if err := syscall.Kill(child, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
				result = errors.Join(result, err)
			}
			break
		}
	}
	return result
}
