//go:build windows

package platform

// EndSession 在 Windows 上结束主体所在的 Job（子孙都在里面）；本进程没记着这个 Job（如重启前拉起的）时不做事。
func EndSession(pid int, _ string) error {
	_, err := killJob(pid)
	return err
}
