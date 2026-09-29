//go:build windows

package platform

import (
	"errors"
	"fmt"
	"io"
	"os"
	"time"
)

// DialEndpoint 打开命名管道；管道不存在返回包着 ErrEndpointGone 的错误，管道全忙（会话还在）当作暂时的。
func DialEndpoint(endpoint string, timeout time.Duration) (io.WriteCloser, error) {
	f, err := os.OpenFile(endpoint, os.O_RDWR, 0)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%w: %w", ErrEndpointGone, err)
		}
		return nil, err
	}
	f.SetDeadline(time.Now().Add(timeout))
	return f, nil
}
