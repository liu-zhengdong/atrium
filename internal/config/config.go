// Package config 定数据目录、端口与服务登记文件的位置。命令行与服务都从这里取，不各自拼路径。
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// DefaultPort 与旧版（4310）错开，两代服务能在同一台机器上并存。
const DefaultPort = 4320

// Paths 是一个数据目录里的全部固定文件。
type Paths struct{ Data string }

func (p Paths) DB() string      { return filepath.Join(p.Data, "atrium.db") }
func (p Paths) Token() string   { return filepath.Join(p.Data, "token") }
func (p Paths) Service() string { return filepath.Join(p.Data, "service.json") }
func (p Paths) Log() string     { return filepath.Join(p.Data, "service.log") }

// Resolve 读 ATRIUM_DATA（缺省 ~/.atrium-v2）；给的是相对路径时按当前目录转绝对。
func Resolve(getenv func(string) string) (Paths, error) {
	dir := strings.TrimSpace(getenv("ATRIUM_DATA"))
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return Paths{}, fmt.Errorf("找不到主目录：%w", err)
		}
		dir = filepath.Join(home, ".atrium-v2")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return Paths{}, err
	}
	return Paths{Data: abs}, nil
}

// Isolated：数据目录不是缺省的那个（ATRIUM_DATA 指向别处，测试、开发起的隔离实例）；缺省目录就是用户的服务。
// 隔离实例不自己拉起本机真实的模型进程：不唤醒负责人、自动挑执行者不挑内置工具。
func (p Paths) Isolated() bool {
	def, err := Resolve(func(string) string { return "" })
	return err != nil || filepath.Clean(def.Data) != filepath.Clean(p.Data)
}

// Port 读 ATRIUM_PORT；显式设 0 时由系统挑空闲端口；没设时缺省数据目录用 4320，隔离的数据目录回 0（监听时由系统挑空闲端口），
// 漏设端口的隔离实例不会撞上用户的服务。实际端口写进登记文件，命令行从那里读。
func Port(p Paths, getenv func(string) string) (int, error) {
	raw := strings.TrimSpace(getenv("ATRIUM_PORT"))
	if raw == "" && p.Isolated() {
		return 0, nil
	}
	if raw == "" {
		return DefaultPort, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 || n > 65535 {
		return 0, fmt.Errorf("ATRIUM_PORT 应为 0–65535 的整数，收到 %q", raw)
	}
	return n, nil
}

// ServiceInfo 是服务登记文件的内容：谁在跑、听哪个端口。
type ServiceInfo struct {
	PID       int    `json:"pid"`
	Port      int    `json:"port"`
	StartedAt int64  `json:"started_at"`
	Version   string `json:"version"`
}

// ErrNotRegistered 表示登记文件不存在（服务没起过或已正常停下）。
var ErrNotRegistered = errors.New("服务没有登记")

func ReadService(p Paths) (ServiceInfo, error) {
	raw, err := os.ReadFile(p.Service())
	if errors.Is(err, os.ErrNotExist) {
		return ServiceInfo{}, ErrNotRegistered
	}
	if err != nil {
		return ServiceInfo{}, err
	}
	var info ServiceInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return ServiceInfo{}, fmt.Errorf("%s 不是合法 JSON：%w", p.Service(), err)
	}
	return info, nil
}

// WriteService 先写临时文件再改名，读的一方不会看到半个文件。
func WriteService(p Paths, info ServiceInfo) error {
	raw, err := json.Marshal(info)
	if err != nil {
		return err
	}
	tmp := p.Service() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p.Service())
}

func ReadToken(p Paths) (string, error) {
	raw, err := os.ReadFile(p.Token())
	if err != nil {
		return "", fmt.Errorf("读不到用户令牌 %s：%w", p.Token(), err)
	}
	return strings.TrimSpace(string(raw)), nil
}
