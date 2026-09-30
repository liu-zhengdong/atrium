// Package platform 是 macOS、Linux、Windows 差异的唯一落点：结束进程树、存活判断、shell 执行、
// PATH 查找、子进程环境白名单。本文件只有纯判定（吃 goos 与参数，不碰进程和文件系统），表驱动测试；
// IO 在 proc*.go。别的包不直接写 syscall.Kill、/bin/sh、taskkill，也不直接 exec.Command 拉子进程。
package platform

import (
	"fmt"
	"path/filepath"
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

// IsBatch：Windows 上 .cmd/.bat 不能直接带参数拉起（cmd.exe 拆参数的规则与常规程序不同），要经 BatchCommandLine。
func IsBatch(goos, path string) bool {
	if goos != "windows" {
		return false
	}
	p := strings.ToLower(path)
	return strings.HasSuffix(p, ".cmd") || strings.HasSuffix(p, ".bat")
}

// BatchCommandLine 是经 cmd.exe 跑 .cmd/.bat 的整条命令行（给 SysProcAttr.CmdLine）：
// `cmd.exe /d /e:on /v:off /s /c ""脚本" 参数…"`。含空白或符号的参数加引号；`"` 写两遍；
// `%` 前插 `%%cd:~,`（与后面的 `%` 合成空子串 `%cd:~,%`）挡住变量展开。换行与空字符进不了批处理的命令行，报错。
func BatchCommandLine(comspec, script string, args []string) (string, error) {
	if comspec == "" {
		comspec = "cmd.exe"
	}
	var b strings.Builder
	b.WriteString(`"` + comspec + `" /d /e:on /v:off /s /c "`)
	for i, a := range append([]string{script}, args...) {
		if strings.ContainsAny(a, "\r\n\x00") {
			return "", fmt.Errorf("经 cmd.exe 拉起 %s 时参数里不能有换行或空字符（第 %d 个参数）", script, i)
		}
		if i > 0 {
			b.WriteByte(' ')
		}
		batchArg(&b, a, i == 0)
	}
	b.WriteByte('"')
	return b.String(), nil
}

// batchArg 写一个参数：只含字母数字与 #$*+-./:?@\_（及非 ASCII）时原样，否则加引号；
// 引号内 `"` 前的反斜杠加倍再写两个 `"`，结尾反斜杠加倍。
func batchArg(b *strings.Builder, a string, quote bool) {
	if a == "" || strings.HasSuffix(a, `\`) {
		quote = true
	}
	for _, r := range a {
		if r < 0x80 && !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune(`#$*+-./:?@\_`, r)) {
			quote = true
		}
	}
	if quote {
		b.WriteByte('"')
	}
	slashes := 0
	for _, r := range a {
		switch r {
		case '\\':
			slashes++
			b.WriteRune(r)
			continue
		case '"':
			b.WriteString(strings.Repeat(`\`, slashes) + `"`)
		case '%':
			b.WriteString(`%%cd:~,`)
		}
		slashes = 0
		b.WriteRune(r)
	}
	if quote {
		b.WriteString(strings.Repeat(`\`, slashes) + `"`)
	}
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
	systemEnv  = set("PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TZ", "TERM", "GOFLAGS")
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

// ServiceEnv 过滤出服务进程的环境：系统基本、Go 编译选项、代理出网、ATRIUM_*（端口、数据目录）。
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

// WorkerEnv 是执行者进程的环境：系统基本、Go 编译选项与代理出网，不传 ATRIUM_*（执行者不该连到派它的服务）、
// 凭据与身份类变量；固定加非交互标记与 ATRIUM_WORKER=1（命令行据此拒绝操作用户的服务）。
// tempDir 非空时统一指定会话临时目录（执行者是任务目录下的 tmp，负责人是自己目录下的 tmp，退出后按它回收残留，见 WaitSession）；自检等不传。
// 任务声明的凭据由调用方在此之后逐个注入。
func WorkerEnv(goos string, base map[string]string, tempDir ...string) map[string]string {
	env := map[string]string{}
	for k, v := range base {
		if name := EnvKey(goos, k); baseAllowed(goos, name) {
			env[name] = v
		}
	}
	// 各工作树共用编译缓存；保留用户选项，再追加路径无关的编译规则。
	env["GOFLAGS"] = strings.TrimSpace(env["GOFLAGS"] + " -trimpath")
	if len(tempDir) > 0 && tempDir[0] != "" {
		for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
			env[key] = tempDir[0]
		}
	}
	env["NO_COLOR"] = "1"
	env["GIT_PAGER"] = "cat"
	env["PAGER"] = "cat"
	env["GH_PROMPT_DISABLED"] = "1"
	env["ATRIUM_WORKER"] = "1"
	return env
}

// envMap 把 os.Environ() 形式转成 map，变量名经 EnvKey（Windows 上的 Path 落成 PATH）；
// EnvList 反过来并按名字排序（结果稳定）。
func envMap(goos string, list []string) map[string]string {
	m := make(map[string]string, len(list))
	for _, kv := range list {
		if i := strings.IndexByte(kv, '='); i > 0 {
			m[EnvKey(goos, kv[:i])] = kv[i+1:]
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

// Browsers 是找无头浏览器的顺序：先 PATH 里的名字（专做截图的 chrome-headless-shell 在前），再各平台的固定安装位置。
func Browsers(goos string) []string {
	names := []string{"chrome-headless-shell", "chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "msedge"}
	switch goos {
	case "darwin":
		return append(names, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
	case "windows":
		return append(names, `C:\Program Files\Google\Chrome\Application\chrome.exe`,
			`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`, `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`)
	}
	return names
}

// ChromeActivePortPath 返回 Chrome 默认资料目录的远程调试标记。
func ChromeActivePortPath(goos, home, localAppData, xdgConfig string) string {
	switch goos {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "DevToolsActivePort")
	case "windows":
		return filepath.Join(localAppData, "Google", "Chrome", "User Data", "DevToolsActivePort")
	default:
		if xdgConfig == "" {
			xdgConfig = filepath.Join(home, ".config")
		}
		return filepath.Join(xdgConfig, "google-chrome", "DevToolsActivePort")
	}
}
