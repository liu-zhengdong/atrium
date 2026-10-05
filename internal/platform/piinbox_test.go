//go:build !windows

package platform

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 假 pi-inbox：收到什么记下来，按脚本逐行回执。
func fakePi(t *testing.T, reply func(i int) (string, bool)) (string, chan []string) {
	t.Helper()
	dir, err := os.MkdirTemp("", "pi") // t.TempDir 路径太长，超过 Unix socket 路径上限
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "s.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got := make(chan []string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		rd := bufio.NewReader(conn)
		var lines []string
		for i := 0; ; i++ {
			line, err := rd.ReadString('\n')
			if err != nil {
				break
			}
			lines = append(lines, strings.TrimSpace(line))
			if i == 0 {
				continue // 鉴权行没有回执
			}
			out, ok := reply(i - 1)
			if !ok {
				break
			}
			if _, err := io.WriteString(conn, out+"\n"); err != nil {
				break
			}
		}
		got <- lines
	}()
	return sock, got
}

func TestSendPiMessages(t *testing.T) {
	sock, got := fakePi(t, func(int) (string, bool) { return `{"ok":true,"delivered":{"mode":"followUp"}}`, true })
	if err := SendPiMessages(sock, "tok", []string{"第一条", "第二条\n带换行"}, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	lines := <-got
	if len(lines) != 3 {
		t.Fatalf("应送 1 行鉴权 + 2 条消息，收到 %d 行：%q", len(lines), lines)
	}
	if lines[0] != "tok" {
		t.Fatalf("首行应是裸 token：%q", lines[0])
	}
	var m inboxMessage
	if err := json.Unmarshal([]byte(lines[1]), &m); err != nil {
		t.Fatalf("第二条不是一行 JSON：%v（%q）", err, lines[1])
	}
	if m.Message != "第一条" || m.As != "external" || m.From != "atrium-secretary" || m.DeliverAs != "followUp" {
		t.Fatalf("消息字段不对：%+v", m)
	}
	if err := json.Unmarshal([]byte(lines[2]), &m); err != nil || m.Message != "第二条\n带换行" {
		t.Fatalf("换行应在 JSON 里转义、整条一行：%v %+v", err, m)
	}
	if strings.Contains(lines[1], "sessionId") {
		t.Fatalf("Pi 的收件地址本身就是一个会话，不该带 sessionId：%q", lines[1])
	}
}

func TestSendPiMessagesRefused(t *testing.T) {
	sock, _ := fakePi(t, func(int) (string, bool) { return `{"ok":false,"error":"rate limited"}`, true })
	err := SendPiMessages(sock, "tok", []string{"一"}, 2*time.Second)
	if err == nil || !strings.Contains(err.Error(), "rate limited") {
		t.Fatalf("会话拒收应报出它的理由：%v", err)
	}
	if !errors.Is(err, ErrInboxRejected) || errors.Is(err, ErrEndpointGone) {
		t.Fatalf("会话拒收应是 ErrInboxRejected，不是连不上：%v", err)
	}
}

func TestPiTokenFor(t *testing.T) {
	home := t.TempDir()
	key := filepath.Join(home, "7.new.key")
	if err := os.WriteFile(key, []byte(`{"token":"t-new","pid":7}`), 0o600); err != nil {
		t.Fatal(err)
	}
	writeInbox(t, home, 7, `{"pid":7,"socketPath":"/tmp/7.sock","keyFile":"`+key+`"}`)
	writeInbox(t, home, 8, `{"pid":8,"socketPath":"/tmp/8.sock","keyFile":"/tmp/没有.key"}`)
	if token, err := PiTokenFor(home, "/tmp/7.sock"); err != nil || token != "t-new" {
		t.Fatalf("应按收件地址读到登记里现在的口令：%v %q", err, token)
	}
	if _, err := PiTokenFor(home, "/tmp/9.sock"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("登记里没有这个收件地址应报 ErrNotExist：%v", err)
	}
	if _, err := PiTokenFor(home, "/tmp/8.sock"); err == nil {
		t.Fatal("口令文件读不出应报错")
	}
}

func TestSendPiMessagesNoReceipt(t *testing.T) {
	sock, _ := fakePi(t, func(int) (string, bool) { return "", false })
	err := SendPiMessages(sock, "tok", []string{"一"}, 2*time.Second)
	if err == nil || !strings.Contains(err.Error(), "没收到回执") {
		t.Fatalf("没有回执应报错（不能当送成功）：%v", err)
	}
}

func TestSendPiMessagesGone(t *testing.T) {
	err := SendPiMessages(filepath.Join(t.TempDir(), "没有这个.sock"), "tok", []string{"一"}, time.Second)
	if !errors.Is(err, ErrEndpointGone) {
		t.Fatalf("收件地址不在应是 ErrEndpointGone：%v", err)
	}
}

func writeInbox(t *testing.T, home string, pid int, body string) {
	t.Helper()
	if err := os.MkdirAll(PiInboxDir(home), 0o700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(PiInboxDir(home), strconv.Itoa(pid)+".json")
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReadPiInbox(t *testing.T) {
	home := t.TempDir()
	writeInbox(t, home, 7, `{"pid":7,"sessionId":"abc12345-6789","name":"秘书","cwd":"/repo","socketPath":"/tmp/a.sock","keyFile":"/tmp/7.key"}`)
	in, err := ReadPiInbox(home, 7)
	if err != nil {
		t.Fatal(err)
	}
	if in.PID != 7 || in.Name != "秘书" || in.Socket != "/tmp/a.sock" || in.KeyFile != "/tmp/7.key" {
		t.Fatalf("读出来的登记不对：%+v", in)
	}
	if _, err := ReadPiInbox(home, 8); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("没有这个 pid 应报 ErrNotExist：%v", err)
	}
	writeInbox(t, home, 9, `{"pid":9,"keyFile":"/tmp/9.key"}`)
	if _, err := ReadPiInbox(home, 9); err == nil || !strings.Contains(err.Error(), "socketPath") {
		t.Fatalf("缺收信地址的登记应报出来：%v", err)
	}
}

func TestListPiInboxNewestFirst(t *testing.T) {
	home := t.TempDir()
	writeInbox(t, home, 1, `{"pid":1,"startedAt":100,"socketPath":"/tmp/1.sock","keyFile":"/tmp/1.key"}`)
	writeInbox(t, home, 2, `{"pid":2,"startedAt":300,"socketPath":"/tmp/2.sock","keyFile":"/tmp/2.key"}`)
	writeInbox(t, home, 3, `{"pid":3,"startedAt":200,"socketPath":"/tmp/3.sock","keyFile":"/tmp/3.key"}`)
	if err := os.WriteFile(filepath.Join(PiInboxDir(home), "note.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	list, err := ListPiInbox(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 || list[0].PID != 2 || list[2].PID != 1 {
		t.Fatalf("应按开始时间新的在前、跳过非登记文件：%+v", list)
	}
	if empty, err := ListPiInbox(t.TempDir()); err != nil || len(empty) != 0 {
		t.Fatalf("没有登记目录应是空列表而不是错误：%v %+v", err, empty)
	}
}

func TestPiInboxToken(t *testing.T) {
	home := t.TempDir()
	key := filepath.Join(home, "7.key")
	if err := os.WriteFile(key, []byte(`{"token":"t-7","pid":7}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if token, err := (PiInbox{KeyFile: key}).Token(); err != nil || token != "t-7" {
		t.Fatalf("读口令：%v %q", err, token)
	}
	if _, err := (PiInbox{KeyFile: filepath.Join(home, "没有.key")}).Token(); err == nil {
		t.Fatal("口令文件不在应报错")
	}
}
