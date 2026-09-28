//go:build windows

package platform

import (
	"os"
	"syscall"
)

const (
	createNewProcessGroup   = 0x00000200
	createNoWindow          = 0x08000000
	processQueryLimitedInfo = 0x1000
	stillActive             = 259
)

// 一律不弹窗；Detached 放进新进程组，结束时由 taskkill /T 连子进程一起结束。cmdLine 非空时原样作命令行（批处理）。
func sysProcAttr(detached bool, cmdLine string) *syscall.SysProcAttr {
	attr := &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow, CmdLine: cmdLine}
	if detached {
		attr.CreationFlags |= createNewProcessGroup
	}
	return attr
}

func killGroup(pid int) error { return nil } // Windows 走 KillTreeInvocation，不会到这里

func alive(pid int) bool {
	h, err := syscall.OpenProcess(processQueryLimitedInfo, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if err := syscall.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == stillActive
}

func isExecutable(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}
