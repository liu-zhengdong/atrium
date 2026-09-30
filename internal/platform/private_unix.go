//go:build !windows

package platform

import "os"

func restrictAccess(path string, dir bool) error {
	mode := os.FileMode(0o600)
	if dir {
		mode = 0o700
	}
	return os.Chmod(path, mode)
}
