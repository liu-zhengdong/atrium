package platform

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
)

func TryFileLock(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	err = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
	if err != nil {
		f.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, nil
		}
		return nil, err
	}
	return f, nil
}

// Windows 不使用 Unix 的 SingletonLock 检测；手动登录后须先关闭专用 Chrome。
func ChromeProfileBusy(string) (bool, error) { return false, nil }
