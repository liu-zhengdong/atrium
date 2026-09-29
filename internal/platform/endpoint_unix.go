//go:build !windows

package platform

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"syscall"
	"time"
)

// DialEndpoint 连 Unix socket。连不上时 stat 一次：socket 文件不存在才返回包着 ErrEndpointGone 的错误；
// 文件还在就是暂时的（拒绝连接：Claude Code 忙着跑工具时会这样），会话关没关由调用方按持续多久判定。
// 错误带原始 errno 编号，日志里能看出是哪一种。
func DialEndpoint(endpoint string, timeout time.Duration) (io.WriteCloser, error) {
	conn, err := net.DialTimeout("unix", endpoint, timeout)
	if err != nil {
		var errno syscall.Errno
		if errors.As(err, &errno) {
			err = fmt.Errorf("%w（errno %d）", err, int(errno))
		}
		if _, serr := os.Stat(endpoint); errors.Is(serr, os.ErrNotExist) {
			return nil, fmt.Errorf("%w: %w", ErrEndpointGone, err)
		}
		return nil, err
	}
	conn.SetDeadline(time.Now().Add(timeout))
	return conn, nil
}
