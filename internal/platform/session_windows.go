//go:build windows

package platform

func killSession(pid int) error {
	_, err := killJob(pid)
	return err
}
