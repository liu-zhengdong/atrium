// Package platform 是 macOS、Linux、Windows 差异的唯一落点：结束进程树、存活判断、shell 执行、
// PATH 查找、子进程环境白名单。本文件只有纯判定（吃 goos 与参数，不碰进程和文件系统），表驱动测试；
// IO 在 proc*.go。别的包不直接写 syscall.Kill、/bin/sh、taskkill，也不直接 exec.Command 拉子进程。
package platform

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Invocation 是一次进程调用：程序与参数。
type Invocation struct {
	Command string
	Args    []string
}

// ShellInvocation：Unix `/bin/sh -c 命令`；Windows `cmd.exe /d /s /c 命令`。
func ShellInvocation(goos, command, comspec string) Invocation {
	if goos == "windows" {
		if comspec == "" {
			comspec = "cmd.exe"
		}
		return Invocation{Command: comspec, Args: []string{"/d", "/s", "/c", command}}
	}
	return Invocation{Command: "/bin/sh", Args: []string{"-c", command}}
}

// ScriptInvocation 跑仓库里的 shell 脚本（如 .agents/check）：Unix 直接执行（靠 shebang）；
// Windows 没有 shebang，交给 sh（Git for Windows 的 sh.exe 或 bash.exe）。
func ScriptInvocation(goos, script, sh string) Invocation {
	if goos == "windows" {
		return Invocation{Command: sh, Args: []string{script}}
	}
	return Invocation{Command: script}
}

// ScriptShells 是 Windows 上跑 shell 脚本要在 PATH 里找的程序，按顺序；Unix 不需要。
func ScriptShells(goos string) []string {
	if goos == "windows" {
		return []string{"sh", "bash"}
	}
	return nil
}

// KillTreeInvocation：Windows 没有进程组信号，用 `taskkill /T /F`；Unix 返回 false，由调用方给进程组发信号。
func KillTreeInvocation(goos string, pid int) (Invocation, bool) {
	if goos != "windows" {
		return Invocation{}, false
	}
	return Invocation{Command: "taskkill", Args: []string{"/T", "/F", "/PID", strconv.Itoa(pid)}}, true
}

const defaultPathExt = ".COM;.EXE;.BAT;.CMD"

// ExecutableNames 是在一个 PATH 目录里要找的文件名：Unix 原名；Windows 已带可执行扩展名时只找原名，
// 否则按 PATHEXT 顺序补扩展名。
func ExecutableNames(goos, name, pathext string) []string {
	if goos != "windows" {
		return []string{name}
	}
	if pathext == "" {
		pathext = defaultPathExt
	}
	var exts []string
	for _, e := range strings.Split(pathext, ";") {
		e = strings.ToLower(strings.TrimSpace(e))
		if strings.HasPrefix(e, ".") {
			exts = append(exts, e)
		}
	}
	lower := strings.ToLower(name)
	for _, e := range exts {
		if strings.HasSuffix(lower, e) {
			return []string{name}
		}
	}
	out := make([]string, len(exts))
	for i, e := range exts {
		out[i] = name + e
	}
	return out
}

// PathListSeparator 是 PATH 的分隔符。
func PathListSeparator(goos string) string {
	if goos == "windows" {
		return ";"
	}
	return ":"
}

// EnvKey：Windows 上变量名不分大小写，统一按大写比对与落键。
func EnvKey(goos, key string) string {
	if goos == "windows" {
		return strings.ToUpper(key)
	}
	return key
}

var (
	systemEnv  = set("PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TZ", "TERM")
	networkEnv = set("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
		"http_proxy", "https_proxy", "no_proxy", "all_proxy", "SSL_CERT_FILE")
	windowsEnv = set("SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
		"USERPROFILE", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
		"PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMPUTERNAME", "NUMBER_OF_PROCESSORS",
		"PROCESSOR_ARCHITECTURE", "OS")
	sensitiveName = regexp.MustCompile(`^(ANTHROPIC|CLAUDE|CLAUDECODE|OPENAI|GH|GITHUB|HERDR|PI)_|_(API_KEY|TOKEN)$|^SSH_AUTH_SOCK$`)
)

func baseAllowed(goos, name string) bool {
	return systemEnv[name] || networkEnv[name] || strings.HasPrefix(name, "LC_") ||
		(goos == "windows" && windowsEnv[name])
}

// ServiceEnv 过滤出服务进程的环境：系统基本、代理出网、ATRIUM_*（端口、数据目录）。
// dropped 是被丢掉的凭据/身份类变量名（只报名字），供 start 回执提示。
func ServiceEnv(goos string, base map[string]string) (env map[string]string, dropped []string) {
	env = map[string]string{}
	for k, v := range base {
		name := EnvKey(goos, k)
		if baseAllowed(goos, name) || strings.HasPrefix(name, "ATRIUM_") {
			env[name] = v
		} else if sensitiveName.MatchString(name) {
			dropped = append(dropped, k)
		}
	}
	sort.Strings(dropped)
	return env, dropped
}

// WorkerEnv 是执行者进程的环境：只有系统基本与代理出网，不传 ATRIUM_*（执行者不该连到派它的服务）、
// 凭据与身份类变量；固定加非交互标记与 ATRIUM_WORKER=1（命令行据此拒绝操作用户的服务）。
// 任务声明的凭据由调用方在此之后逐个注入。
func WorkerEnv(goos string, base map[string]string) map[string]string {
	env := map[string]string{}
	for k, v := range base {
		if name := EnvKey(goos, k); baseAllowed(goos, name) {
			env[name] = v
		}
	}
	env["NO_COLOR"] = "1"
	env["GIT_PAGER"] = "cat"
	env["PAGER"] = "cat"
	env["GH_PROMPT_DISABLED"] = "1"
	env["ATRIUM_WORKER"] = "1"
	return env
}

// EnvMap 把 os.Environ() 形式转成 map；EnvList 反过来并按名字排序（结果稳定）。
func EnvMap(list []string) map[string]string {
	m := make(map[string]string, len(list))
	for _, kv := range list {
		if i := strings.IndexByte(kv, '='); i > 0 {
			m[kv[:i]] = kv[i+1:]
		}
	}
	return m
}

func EnvList(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

func set(names ...string) map[string]bool {
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[n] = true
	}
	return m
}
