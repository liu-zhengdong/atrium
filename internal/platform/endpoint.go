package platform

import (
	"errors"
	"io"
	"path"
	"regexp"
	"strings"
	"time"
)

// 本文件是 Claude Code 会话收件地址（secretary bridge 用）：Unix 上是 socket 文件，Windows 上是命名管道。
// MessagingEndpoint 是纯判定；DialEndpoint、EndpointGone 的平台差异在 endpoint_unix.go、endpoint_windows.go。

var pipePattern = regexp.MustCompile(`(?i)^\\\\[.?]\\pipe\\[^\\]+`)

// MessagingEndpoint 从 CLAUDE_CODE_MESSAGING_SOCKET 认出收件地址；认不出返回空。
func MessagingEndpoint(goos, raw string) string {
	p := strings.TrimPrefix(strings.TrimSpace(raw), "uds:")
	if p == "" || strings.ContainsAny(p, "\r\n\x00") {
		return ""
	}
	if goos == "windows" {
		if pipePattern.MatchString(p) {
			return p
		}
		return ""
	}
	if path.IsAbs(p) {
		return p
	}
	return ""
}

// ErrEndpointGone 表示会话已经没了（地址不在、没人监听）；其余错误当作暂时的。
var ErrEndpointGone = errors.New("会话收件地址不在了")

// SendLines 连上收件地址，写完各行（每行以换行结尾）后关闭。Claude Code 不回执：写完没出错就算送到。
func SendLines(endpoint string, lines []string, timeout time.Duration) error {
	conn, err := DialEndpoint(endpoint, timeout)
	if err != nil {
		return err
	}
	defer conn.Close()
	_, err = io.WriteString(conn, strings.Join(lines, "\n")+"\n")
	return err
}

// ProbeEndpoint 连一下就断，不发内容：看会话还在不在。
func ProbeEndpoint(endpoint string, timeout time.Duration) error {
	conn, err := DialEndpoint(endpoint, timeout)
	if err != nil {
		return err
	}
	return conn.Close()
}
