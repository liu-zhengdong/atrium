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

// fakeDSH 假一个 dsh-atrium 收件地址：收下鉴权行与消息行，逐条按脚本回执。
// 线上协议与 pi-inbox 是同一套（inbox.go），所以这里的形状照 fakePi。
func fakeDSH(t *testing.T, reply func(i int) (string, bool)) (string, chan []string) {
	t.Helper()
	dir, err := os.MkdirTemp("", "dsh") // t.TempDir 路径太长，超过 Unix socket 路径上限
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

// writeDSHInbox 写一份 dsh-atrium 的登记。
func writeDSHInbox(t *testing.T, dshHome string, in DSHInbox) {
	t.Helper()
	dir := DSHInboxDir(dshHome)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, strconv.Itoa(in.PID)+".json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

// 登记：读字段、按 startedAt 新的在前、认不出的文件跳过、口令与按收件地址找口令。
func TestDSHInboxReadListToken(t *testing.T) {
	dshHome := t.TempDir()
	key := filepath.Join(dshHome, "7.key")
	if err := os.WriteFile(key, []byte(`{"protocol":1,"token":"t7"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	writeDSHInbox(t, dshHome, DSHInbox{Protocol: 1, PID: 7, Profile: "atrium", Socket: "/tmp/7.sock", KeyFile: key,
		StartedAt: 200, Sessions: []DSHSession{{ID: "session-aaaa1111"}}})
	writeDSHInbox(t, dshHome, DSHInbox{Protocol: 1, PID: 8, Socket: "/tmp/8.sock", KeyFile: key, StartedAt: 100})
	// 认不出的跳过：不是 JSON 的、没有收信地址的。
	if err := os.WriteFile(filepath.Join(DSHInboxDir(dshHome), "bad.json"), []byte("不是 JSON"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeDSHInbox(t, dshHome, DSHInbox{Protocol: 1, PID: 9, KeyFile: key, StartedAt: 300})

	list, err := ListDSHInbox(dshHome)
	if err != nil || len(list) != 2 || list[0].PID != 7 || list[1].PID != 8 {
		t.Fatalf("登记应读到两条、新的在前：%v %+v", err, list)
	}
	in, err := ReadDSHInbox(dshHome, 7)
	if err != nil || in.Profile != "atrium" || in.Socket != "/tmp/7.sock" || len(in.Sessions) != 1 {
		t.Fatalf("读登记：%v %+v", err, in)
	}
	if !in.HasSession("session-aa") || in.HasSession("session-bb") {
		t.Fatalf("按会话 id 前缀认会话：%+v", in.Sessions)
	}
	if token, err := in.Token(); err != nil || token != "t7" {
		t.Fatalf("读口令：%v %q", err, token)
	}
	if token, err := DSHTokenFor(dshHome, "/tmp/8.sock"); err != nil || token != "t7" {
		t.Fatalf("按收件地址读口令：%v %q", err, token)
	}
	if _, err := DSHTokenFor(dshHome, "/tmp/没有.sock"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("没有这个收件地址应包着 os.ErrNotExist：%v", err)
	}
	if _, err := ReadDSHInbox(dshHome, 99); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("没有这个 pid 应包着 os.ErrNotExist：%v", err)
	}
}

// DSH 的数据根：$DSH_HOME 优先（空白的忽略），否则 ~/.dsh。
func TestDSHHome(t *testing.T) {
	empty := func(string) string { return "" }
	if got := DSHHome("/home/u", empty); got != filepath.Join("/home/u", ".dsh") {
		t.Fatalf("没有 $DSH_HOME 时用 ~/.dsh：%q", got)
	}
	if got := DSHHome("/home/u", func(k string) string { return map[string]string{"DSH_HOME": " /data/dsh "}[k] }); got != "/data/dsh" {
		t.Fatalf("$DSH_HOME 优先：%q", got)
	}
	if got := DSHHome("/home/u", func(k string) string { return map[string]string{"DSH_HOME": "   "}[k] }); got != filepath.Join("/home/u", ".dsh") {
		t.Fatalf("空白的 $DSH_HOME 不算：%q", got)
	}
}

func TestSendDSHMessages(t *testing.T) {
	sock, got := fakeDSH(t, func(int) (string, bool) { return `{"ok":true,"deliverAs":"followUp"}`, true })
	if err := SendDSHMessages(sock, "tok", []string{"第一条", "第二条\n带换行"}, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	lines := <-got
	if len(lines) != 3 || lines[0] != "tok" {
		t.Fatalf("应送 1 行鉴权 + 2 条消息，首行是裸 token：%q", lines)
	}
	var m inboxMessage
	if err := json.Unmarshal([]byte(lines[1]), &m); err != nil {
		t.Fatalf("第二条不是一行 JSON：%v（%q）", err, lines[1])
	}
	if m.Message != "第一条" || m.As != "external" || m.From != "atrium-secretary" || m.DeliverAs != "followUp" {
		t.Fatalf("消息字段不对：%+v", m)
	}
}

func TestSendDSHMessagesRefused(t *testing.T) {
	sock, _ := fakeDSH(t, func(int) (string, bool) { return `{"ok":false,"error":"unauthorized"}`, true })
	err := SendDSHMessages(sock, "错的口令", []string{"一"}, 2*time.Second)
	if err == nil || !strings.Contains(err.Error(), "unauthorized") {
		t.Fatalf("会话拒收应报出它的理由：%v", err)
	}
	if !errors.Is(err, ErrInboxRejected) || errors.Is(err, ErrEndpointGone) {
		t.Fatalf("会话拒收应是 ErrInboxRejected，不是连不上：%v", err)
	}
}
