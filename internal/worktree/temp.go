package worktree

import (
	"io/fs"
	"os"
	"path/filepath"
)

// RemoveTemp 删除调用方已核实归属的任务临时目录，包括只读的 Go 模块缓存。
// WalkDir 不跟随符号链接；不改变链接指向的外部文件权限。
func RemoveTemp(dir string) error {
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if os.IsNotExist(err) && path == dir {
			return nil
		}
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		mode := info.Mode().Perm() | 0o600
		if entry.IsDir() {
			mode |= 0o100
		}
		return os.Chmod(path, mode)
	})
	if err != nil {
		return err
	}
	return os.RemoveAll(dir)
}
