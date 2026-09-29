//go:build !windows

package platform

import (
	"errors"
	"fmt"
	"io"
	"net"
	"syscall"
	"time"
)

// DialEndpoint 连 Unix socket；socket 文件不在返回包着 ErrEndpointGone 的错误（带原错误）。
// 文件还在但连不上（拒绝连接：Claude Code 忙着跑工具时会这样）当作暂时的，会话关没关由调用方按持续多久判定。
func DialEndpoint(endpoint string, timeout time.Duration) (io.WriteCloser, error) {
	conn, err := net.DialTimeout("unix", endpoint, timeout)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) {
			return nil, fmt.Errorf("%w: %w", ErrEndpointGone, err)
		}
		return nil, err
	}
	conn.SetDeadline(time.Now().Add(timeout))
	return conn, nil
}
