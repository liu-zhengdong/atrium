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

// 本文件是 DSH 会话收件地址（secretary bridge 用）：dsh-atrium 插件（dsh-atrium/src/index.js）
// 每个 DSH 进程登记一份，记着它监听的 Unix socket、口令文件与此刻活着的会话。
// 线上协议见 inbox.go（与 Pi 共用）。

// DSHHome 是 DSH 的数据根目录：$DSH_HOME（空白的忽略）优先，否则 ~/.dsh。
func DSHHome(home string, getenv func(string) string) string {
	if v := strings.TrimSpace(getenv("DSH_HOME")); v != "" {
		return v
	}
	return filepath.Join(home, ".dsh")
}

// DSHInboxDir 是 dsh-atrium 的登记目录。
func DSHInboxDir(dshHome string) string { return filepath.Join(dshHome, "atrium", "inbox") }

// DSHSession 是这个 DSH 进程里活着的会话之一；cwd 目前常为空，挑会话按 id。
type DSHSession struct {
	ID  string `json:"id"`
	Cwd string `json:"cwd"`
}

// DSHInbox 是 dsh-atrium 写的登记。
type DSHInbox struct {
	Protocol  int          `json:"protocol"`
	PID       int          `json:"pid"`
	Profile   string       `json:"profile"`
	Socket    string       `json:"socketPath"`
	KeyFile   string       `json:"keyFile"`
	StartedAt int64        `json:"startedAt"`
	Sessions  []DSHSession `json:"sessions"`
}

// ReadDSHInbox 读某个 pid 的登记；没有登记时返回包着 os.ErrNotExist 的错误。
func ReadDSHInbox(dshHome string, pid int) (*DSHInbox, error) {
	file := filepath.Join(DSHInboxDir(dshHome), strconv.Itoa(pid)+".json")
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var in DSHInbox
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, fmt.Errorf("%s 不是合法 JSON：%w", file, err)
	}
	if err := in.usable(); err != nil {
		return nil, fmt.Errorf("%s：%w", file, err)
	}
	return &in, nil
}

// ListDSHInbox 读全部登记，新的在前；认不出的文件跳过（进程退出留下的过期记录由插件自己清）。
func ListDSHInbox(dshHome string) ([]DSHInbox, error) {
	entries, err := os.ReadDir(DSHInboxDir(dshHome))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []DSHInbox
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSuffix(e.Name(), ".json"))
		if err != nil {
			continue
		}
		in, err := ReadDSHInbox(dshHome, pid)
		if err != nil {
			continue
		}
		out = append(out, *in)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt > out[j].StartedAt })
	return out, nil
}

// DSHTokenFor 按收件地址在登记里找会话并读它此刻的口令：插件每次加载换口令与口令文件，
// 收件地址按 pid 定、不变，所以被拒收后靠它取新口令。没有这个收件地址的登记时返回包着 os.ErrNotExist 的错误。
func DSHTokenFor(dshHome, socket string) (string, error) {
	list, err := ListDSHInbox(dshHome)
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
func (in DSHInbox) Token() (string, error) {
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

// HasSession 报这个 DSH 进程里有没有 id 以 q 开头的会话（挑会话用）。
func (in DSHInbox) HasSession(q string) bool {
	for _, s := range in.Sessions {
		if strings.HasPrefix(s.ID, q) {
			return true
		}
	}
	return false
}

func (in DSHInbox) usable() error {
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

// SendDSHMessages 投递若干条消息并逐条读回执；线上协议与 Pi 共用（inbox.go）。
func SendDSHMessages(endpoint, token string, messages []string, timeout time.Duration) error {
	return sendInboxMessages("DSH", endpoint, token, messages, timeout)
}
