//go:build !windows

package secretary

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/platform"
)

// 假 Pi 会话：口令对得上才逐条回 ok，否则回 unauthorized（pi-inbox 的行为）；口令可随时换，模拟会话重载。
type fakePiSession struct {
	sock  string
	mu    sync.Mutex
	token string
	got   []string
}

func (f *fakePiSession) rotate(token string) { f.mu.Lock(); f.token = token; f.mu.Unlock() }

func (f *fakePiSession) delivered() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.got...)
}

func newFakePiSession(t *testing.T, token string) *fakePiSession {
	t.Helper()
	dir, err := os.MkdirTemp("", "pi") // t.TempDir 路径太长，超过 Unix socket 路径上限
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	f := &fakePiSession{sock: filepath.Join(dir, "s.sock"), token: token}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: f.sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(conn)
		}
	}()
	return f
}

func (f *fakePiSession) serve(conn net.Conn) {
	defer conn.Close()
	rd := bufio.NewReader(conn)
	auth, err := rd.ReadString('\n')
	if err != nil {
		return
	}
	f.mu.Lock()
	ok := strings.TrimSpace(auth) == f.token
	f.mu.Unlock()
	if !ok {
		io.WriteString(conn, `{"ok":false,"error":"unauthorized"}`+"\n")
		return
	}
	for {
		line, err := rd.ReadString('\n')
		if err != nil {
			return
		}
		f.mu.Lock()
		f.got = append(f.got, strings.TrimSpace(line))
		f.mu.Unlock()
		io.WriteString(conn, `{"ok":true}`+"\n")
	}
}

// piRegistry 按 pi-inbox 的样子在 home 里登记一个会话：收件地址 sock，口令写在新的口令文件里。
func piRegistry(t *testing.T, home, sock, token string) {
	t.Helper()
	dir := platform.PiInboxDir(home)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	key := filepath.Join(dir, "7."+token+".key")
	if err := os.WriteFile(key, []byte(`{"token":"`+token+`","pid":7}`), 0o600); err != nil {
		t.Fatal(err)
	}
	reg := `{"pid":7,"socketPath":` + strconv.Quote(sock) + `,"keyFile":` + strconv.Quote(key) + `}`
	if err := os.WriteFile(filepath.Join(dir, "7.json"), []byte(reg), 0o600); err != nil {
		t.Fatal(err)
	}
}

func piBridge(t *testing.T, sock, token string) (*bridge, *bytes.Buffer) {
	var buf bytes.Buffer
	return &bridge{in: inbox{kind: kindPi, endpoint: sock, token: token}, home: t.TempDir(),
		p: config.Paths{Data: t.TempDir()}, me: os.Getpid(), log: log.New(&buf, "", 0)}, &buf
}

func TestSendRereadsRotatedToken(t *testing.T) {
	pi := newFakePiSession(t, "old-token")
	b, logs := piBridge(t, pi.sock, "old-token")
	if err := b.send("第一批"); err != nil {
		t.Fatal(err)
	}
	pi.rotate("new-token")
	piRegistry(t, b.home, pi.sock, "new-token")
	if err := b.send("第二批"); err != nil {
		t.Fatalf("口令换了应重读后送成功：%v", err)
	}
	if b.in.token != "new-token" {
		t.Fatal("重读到的口令应留着给之后的投递用")
	}
	if got := pi.delivered(); len(got) != 2 || !strings.Contains(got[1], "第二批") {
		t.Fatalf("两批都应送进会话：%q", got)
	}
	if !strings.Contains(logs.String(), "重读口令") || strings.Contains(logs.String(), "new-token") {
		t.Fatalf("恢复应记一行日志，且不记口令：%q", logs.String())
	}
}

func TestSendRejectedGivesUp(t *testing.T) {
	cases := []struct {
		name, registered, want string
	}{
		{"登记没了", "", "重读口令失败"},
		{"重读后仍拒收", "still-wrong", "重读口令后重送"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pi := newFakePiSession(t, "current")
			b, _ := piBridge(t, pi.sock, "old-token")
			if c.registered != "" {
				piRegistry(t, b.home, pi.sock, c.registered)
			}
			err := b.send("一批")
			if !errors.Is(err, platform.ErrInboxRejected) || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("应报拒收并说明原因（%s）：%v", c.want, err)
			}
			if len(pi.delivered()) != 0 {
				t.Fatalf("不应送进去：%q", pi.delivered())
			}
		})
	}
}

func TestSendGoneIsNotRejected(t *testing.T) {
	b, _ := piBridge(t, filepath.Join(t.TempDir(), "没有.sock"), "tok")
	err := b.send("一批")
	if errors.Is(err, platform.ErrInboxRejected) || !errors.Is(err, platform.ErrEndpointGone) {
		t.Fatalf("收件地址不在仍走 Liveness（ErrEndpointGone），不当拒收：%v", err)
	}
}

func TestNoteDelivery(t *testing.T) {
	b, _ := piBridge(t, "/tmp/x.sock", "tok")
	if err := writeRecord(b.p, Record{PID: b.me, Socket: "/tmp/x.sock", Kind: kindPi}); err != nil {
		t.Fatal(err)
	}
	b.noteDelivery(errors.New("会话没收下：unauthorized；重读口令失败：登记里已没有"))
	r, _ := readRecord(b.p)
	if r.Failure == "" || r.FailedAt == 0 || r.Socket != "/tmp/x.sock" {
		t.Fatalf("失败应记原因与时刻、不动其他字段：%+v", r)
	}
	first := r.FailedAt
	time.Sleep(5 * time.Millisecond)
	b.noteDelivery(errors.New("会话没收下：unauthorized；重读口令失败：登记里已没有"))
	if r, _ = readRecord(b.p); r.FailedAt <= first {
		t.Fatalf("同样的错误再失败一次，时刻应更新到这一次：%d → %d", first, r.FailedAt)
	}
	b.noteDelivery(nil)
	if r, _ = readRecord(b.p); r.Failure != "" || r.FailedAt != 0 {
		t.Fatalf("送成功后应清掉失败：%+v", r)
	}
	if err := writeRecord(b.p, Record{PID: b.me + 1, Socket: "/tmp/y.sock"}); err != nil {
		t.Fatal(err)
	}
	b.noteDelivery(errors.New("x"))
	if r, _ = readRecord(b.p); r.Failure != "" {
		t.Fatalf("登记已换人时不应改它：%+v", r)
	}
}

func TestReleaseKeepsRecordAfterFailure(t *testing.T) {
	b, _ := piBridge(t, "/tmp/x.sock", "tok")
	if err := writeRecord(b.p, Record{PID: b.me, Socket: "/tmp/x.sock", Kind: kindPi}); err != nil {
		t.Fatal(err)
	}
	b.noteDelivery(errors.New("会话没收下：unauthorized；重读口令后重送：会话没收下：unauthorized"))
	b.release()
	r, _ := readRecord(b.p)
	if r == nil || r.Failure == "" {
		t.Fatalf("带着失败退出应留下登记给 --status 看：%+v", r)
	}
	b.noteDelivery(nil)
	b.release()
	if r, _ = readRecord(b.p); r != nil {
		t.Fatalf("最近一次送成功，退出时应删登记：%+v", r)
	}
}
