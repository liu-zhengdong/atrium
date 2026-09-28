//go:build !windows

package platform

import (
	"errors"
	"io"
	"net"
	"syscall"
	"time"
)

// DialEndpoint 连 Unix socket；会话没了（文件不在、没人监听）返回包着 ErrEndpointGone 的错误。
func DialEndpoint(endpoint string, timeout time.Duration) (io.WriteCloser, error) {
	conn, err := net.DialTimeout("unix", endpoint, timeout)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ENOTSOCK) {
			return nil, errors.Join(ErrEndpointGone, err)
		}
		return nil, err
	}
	conn.SetDeadline(time.Now().Add(timeout))
	return conn, nil
}
