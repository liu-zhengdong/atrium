//go:build !windows

package platform

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// TryFileLock 返回进程持有的非阻塞锁；关闭文件或进程退出即释放。锁文件不删除，避免换 inode 后双重持锁。
func TryFileLock(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if err != nil {
		f.Close()
		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil, nil
		}
		return nil, err
	}
	return f, nil
}

// ChromeProfileBusy 只认存活的 Chrome SingletonLock；死进程的残留交给 Chrome 自己清理。
func ChromeProfileBusy(profile string) (bool, error) {
	target, err := os.Readlink(filepath.Join(profile, "SingletonLock"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	host, err := os.Hostname()
	if err != nil {
		return false, err
	}
	i := strings.LastIndex(target, "-")
	if i < 0 || target[:i] != host {
		return true, nil
	}
	pid, err := strconv.Atoi(target[i+1:])
	if err != nil {
		return true, nil
	}
	return Alive(pid), nil
}
