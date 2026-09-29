//go:build !windows

package platform

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// socket 文件不在才算 ErrEndpointGone；文件还在但没人接（拒绝连接）、不是 socket 都是暂时的。
func TestDialEndpointGone(t *testing.T) {
	dir, err := os.MkdirTemp("", "ep") // t.TempDir 路径太长，超过 Unix socket 路径上限
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "s.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	if err := ProbeEndpoint(sock, time.Second); err != nil {
		t.Fatalf("有人监听：%v", err)
	}
	ln.SetUnlinkOnClose(false)
	ln.Close()
	if err := ProbeEndpoint(sock, time.Second); err == nil || errors.Is(err, ErrEndpointGone) {
		t.Fatalf("文件还在、拒绝连接应是暂时错误：%v", err)
	}
	os.Remove(sock)
	if err := os.WriteFile(sock, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ProbeEndpoint(sock, time.Second); err == nil || errors.Is(err, ErrEndpointGone) {
		t.Fatalf("文件还在（不是 socket）应是暂时错误：%v", err)
	}
	os.Remove(sock)
	if err := ProbeEndpoint(sock, time.Second); !errors.Is(err, ErrEndpointGone) {
		t.Fatalf("文件不在应是 ErrEndpointGone：%v", err)
	}
}
