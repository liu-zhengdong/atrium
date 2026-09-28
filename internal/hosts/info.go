package hosts

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/service"
)

// 一台机器的自我介绍：系统、核数、装了哪些编码 CLI 及是否登录（只看登录文件在不在，不读内容）。
// 服务登记本机与代理接入远程机器用同一份。

// loginFiles：各工具登录后留下的文件（相对主目录）。
var loginFiles = map[string][]string{
	"claude":   {".claude/.credentials.json", ".claude.json"},
	"codex":    {".codex/auth.json", ".config/codex/auth.json"},
	"opencode": {".local/share/opencode/auth.json"},
}

// LoggedIn 判是否登录（纯函数）：有登录文件算登录；codex 没文件就是没登录；claude 在 macOS 上可能只在钥匙串里，
// 没文件时看不出；其余看不出为 nil。
func LoggedIn(tool, goos string, exists func(rel string) bool) *bool {
	yes, no := true, false
	for _, f := range loginFiles[tool] {
		if exists(f) {
			return &yes
		}
	}
	switch {
	case tool == "codex", tool == "claude" && goos != "darwin":
		return &no
	}
	return nil
}

// MaxWorkers：ATRIUM_MAX_WORKERS 给了就用它，否则核数的一半（至少 1）。
func MaxWorkers(env map[string]string, cpus int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(env["ATRIUM_MAX_WORKERS"])); err == nil && n > 0 {
		return n
	}
	return max(1, cpus/2)
}

// machineInfo 按给定环境（PATH、HOME）看这台机器。
func machineInfo(data string, env map[string]string) Info {
	name, _ := os.Hostname()
	home := env[platform.EnvKey(runtime.GOOS, "HOME")]
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	clis := map[string]CLI{}
	for _, t := range Tools {
		if _, err := platform.LookPath(t.Exe, env); err != nil {
			continue
		}
		clis[t.Name] = CLI{Installed: true, LoggedIn: LoggedIn(t.Name, runtime.GOOS, func(rel string) bool {
			_, err := os.Stat(filepath.Join(home, filepath.FromSlash(rel)))
			return err == nil
		})}
	}
	return Info{Hostname: name, OS: runtime.GOOS, Arch: runtime.GOARCH, CPUs: runtime.NumCPU(),
		Version: service.Version, Data: data, CLIs: clis, MaxWorkers: MaxWorkers(env, runtime.NumCPU())}
}

// LocalInfo 是服务这台（h1）的机器信息。
func LocalInfo(data string) Info { return machineInfo(data, platform.EnvMap(os.Environ())) }

// ParseLoadavg 解析 /proc/loadavg 或 sysctl vm.loadavg 的输出，取 1 分钟负载（纯函数）。
func ParseLoadavg(s string) (float64, bool) {
	f := strings.Fields(strings.Trim(strings.TrimSpace(s), "{}"))
	if len(f) == 0 {
		return 0, false
	}
	v, err := strconv.ParseFloat(f[0], 64)
	return v, err == nil
}

// BusyReason：1 分钟负载超过核数的 1.5 倍算太忙（纯函数）。
func BusyReason(load float64, cpus int) string {
	if cpus > 0 && load >= float64(cpus)*1.5 {
		return fmt.Sprintf("负载 %.1f 超过核数 %d 的 1.5 倍，等负载降下来再派", load, cpus)
	}
	return ""
}

// loadavg 读 1 分钟负载；Windows 没有，报 0。
func loadavg() float64 {
	switch runtime.GOOS {
	case "linux":
		b, err := os.ReadFile("/proc/loadavg")
		if err == nil {
			v, _ := ParseLoadavg(string(b))
			return v
		}
	case "darwin":
		var out bytes.Buffer
		cmd, err := platform.Start(platform.Spec{Path: "/usr/sbin/sysctl", Args: []string{"-n", "vm.loadavg"}, Env: map[string]string{}, Stdout: &out})
		if err == nil {
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case <-done:
				v, _ := ParseLoadavg(out.String())
				return v
			case <-time.After(3 * time.Second):
				cmd.Process.Kill()
				<-done
			}
		}
	}
	return 0
}
