package platform

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// 本文件是 Pi 会话收件地址（secretary bridge 用）：pi-inbox 扩展（~/.pi/agent/extensions/pi-inbox.ts）
// 每个会话登记一份，记着它监听的 Unix socket 与口令文件的路径。
//
// 协议：首行鉴权（裸 token），之后一行一条
// {"message":…,"as":"external|user","from":…,"deliverAs":"auto|steer|followUp"}，
// 每行回一条 {"ok":true,…} 或 {"ok":false,"error":"…"}。

// PiInbox 是 pi-inbox 写的会话登记。
type PiInbox struct {
	Protocol  int    `json:"protocol"`
	PID       int    `json:"pid"`
	SessionID string `json:"sessionId"`
	Name      string `json:"name"`
	Cwd       string `json:"cwd"`
	Socket    string `json:"socketPath"`
	KeyFile   string `json:"keyFile"`
	StartedAt int64  `json:"startedAt"`
}

// PiInboxDir 是 pi-inbox 的登记目录。
func PiInboxDir(home string) string { return filepath.Join(home, ".pi", "agent", "inbox") }

// ReadPiInbox 读某个 pid 的登记；没有登记时返回包着 os.ErrNotExist 的错误。
func ReadPiInbox(home string, pid int) (*PiInbox, error) {
	file := filepath.Join(PiInboxDir(home), strconv.Itoa(pid)+".json")
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var in PiInbox
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, fmt.Errorf("%s 不是合法 JSON：%w", file, err)
	}
	if err := in.usable(); err != nil {
		return nil, fmt.Errorf("%s：%w", file, err)
	}
	return &in, nil
}

// ListPiInbox 读全部登记，新的在前；认不出的文件跳过（pid 复用留下的过期记录由 pi-inbox 自己清）。
func ListPiInbox(home string) ([]PiInbox, error) {
	entries, err := os.ReadDir(PiInboxDir(home))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []PiInbox
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSuffix(e.Name(), ".json"))
		if err != nil {
			continue
		}
		in, err := ReadPiInbox(home, pid)
		if err != nil {
			continue
		}
		out = append(out, *in)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt > out[j].StartedAt })
	return out, nil
}

// PiTokenFor 按收件地址在登记里找会话并读它此刻的口令：pi-inbox 每次 session_start 换口令和口令文件，
// 收件地址按 pid 定、不变，所以被拒收后靠它取新口令。没有这个收件地址的登记时返回包着 os.ErrNotExist 的错误。
func PiTokenFor(home, socket string) (string, error) {
	list, err := ListPiInbox(home)
	if err != nil {
		return "", err
	}
	for _, in := range list {
		if in.Socket == socket {
			return in.Token()
		}
	}
	return "", fmt.Errorf("登记里已没有收件地址 %s：%w", socket, os.ErrNotExist)
}

// Token 读口令文件。口令只在本机、只给 bridge 用，不进日志。
func (in PiInbox) Token() (string, error) {
	raw, err := os.ReadFile(in.KeyFile)
	if err != nil {
		return "", err
	}
	var k struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(raw, &k); err != nil {
		return "", fmt.Errorf("%s 不是合法 JSON：%w", in.KeyFile, err)
	}
	if k.Token == "" {
		return "", fmt.Errorf("%s 里没有 token", in.KeyFile)
	}
	return k.Token, nil
}

func (in PiInbox) usable() error {
	switch {
	case in.PID <= 0:
		return errors.New("登记里没有 pid")
	case in.Socket == "":
		return errors.New("登记里没有收信地址（socketPath）")
	case in.KeyFile == "":
		return errors.New("登记里没有口令文件（keyFile）")
	}
	return nil
}

// piMessage 是投给 Pi 会话的一条消息；一条一个 JSON，换行在 JSON 里转义。
type piMessage struct {
	Message   string `json:"message"`
	As        string `json:"as"`
	From      string `json:"from"`
	DeliverAs string `json:"deliverAs"`
}

// ErrPiRejected：连上了会话，但会话回执拒收（如口令不对的 unauthorized）。和连不上分开：重试连接救不了它。
var ErrPiRejected = errors.New("会话没收下")

// SendPiMessages 投递若干条消息并逐条读回执；任一条没收下就报错（会话拒收的包着 ErrPiRejected）。
// deliverAs=followUp：秘书会话忙时不打断，排在当前这轮之后。
func SendPiMessages(endpoint, token string, messages []string, timeout time.Duration) error {
	conn, err := DialEndpoint(endpoint, timeout)
	if err != nil {
		return err
	}
	defer conn.Close()
	rw, ok := conn.(io.ReadWriter)
	if !ok {
		return fmt.Errorf("Pi 收件地址 %s 不能读回执（只支持 Unix socket）", endpoint)
	}
	var w strings.Builder
	w.WriteString(token)
	w.WriteByte('\n')
	for _, m := range messages {
		raw, err := json.Marshal(piMessage{Message: m, As: "external", From: "atrium-secretary", DeliverAs: "followUp"})
		if err != nil {
			return err
		}
		w.Write(raw)
		w.WriteByte('\n')
	}
	if _, err := io.WriteString(rw, w.String()); err != nil {
		return err
	}
	rd := bufio.NewReader(rw)
	for i := range messages {
		line, err := rd.ReadString('\n')
		if err != nil {
			return fmt.Errorf("送出 %d 条后没收到回执：%w", i, err)
		}
		var reply struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal([]byte(line), &reply); err != nil {
			return fmt.Errorf("回执认不出（%q）：%w", strings.TrimSpace(line), err)
		}
		if !reply.OK {
			return fmt.Errorf("%w：%s", ErrPiRejected, reply.Error)
		}
	}
	return nil
}
