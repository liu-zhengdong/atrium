package platform

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// 本文件是 Pi 会话收件地址（secretary bridge 用）：pi-inbox 扩展（~/.pi/agent/extensions/pi-inbox.ts）
// 每个会话登记一份，记着它监听的 Unix socket 与口令文件的路径。线上协议见 inbox.go（与 DSH 共用）。

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

// SendPiMessages 投递若干条消息并逐条读回执；线上协议与 DSH 共用（inbox.go）。
// 不带 sessionId：Pi 的收件地址本身就是一个会话。
func SendPiMessages(endpoint, token string, messages []string, timeout time.Duration) error {
	return sendInboxMessages("Pi", endpoint, token, "", messages, timeout)
}
