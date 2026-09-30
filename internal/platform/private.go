package platform

import "os"

// PrivateDir 在写入凭据前限制目录访问；已有目录也收紧权限。
func PrivateDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return restrictAccess(path, true)
}

// WritePrivateFile 先限制访问，再写入内容，避免凭据短暂继承父目录权限。
func WritePrivateFile(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := restrictAccess(path, false); err != nil {
		return err
	}
	if err := f.Truncate(0); err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		return err
	}
	return f.Close()
}

// RestrictFile 收紧已有凭据文件权限。
func RestrictFile(path string) error { return restrictAccess(path, false) }
