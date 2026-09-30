package platform

import "os"

// PrivateDir 在写入凭据前限制目录访问；已有目录也收紧权限。
func PrivateDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return restrictAccess(path, true)
}

// WritePrivateFile 是凭据类文件唯一的写法：先写同目录临时文件，写入前限制访问（Windows 上是受保护的 DACL，
// 不靠继承父目录），再改名替换，读的一方不会看到半个文件，旧文件的宽权限也不会留下。
func WritePrivateFile(path string, data []byte) (err error) {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		f.Close()
		if err != nil {
			os.Remove(tmp)
		}
	}()
	if err := restrictAccess(tmp, false); err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// RestrictFile 收紧已有凭据文件权限。
func RestrictFile(path string) error { return restrictAccess(path, false) }
