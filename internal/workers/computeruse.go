package workers

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/pelletier/go-toml/v2"
)

// 执行者工具由 Atrium 显式给出，不继承用户个人 MCP：
// codex 带本机 computer use，关闭 ChatGPT apps；claude 仅带显式的 MCP。
// 两者在 Chrome 资料目录存在 DevToolsActivePort 时带 chrome-devtools MCP，
// 用 --browser-url 连接已开的 Chrome，不启动浏览器。没开远程调试就不带。
// computer use 操作本机应用；chrome-devtools 操作用户已开远程调试的 Chrome；
// Browser 插件需要 Chrome 扩展，不带。用不用由 k26 管：用户指定实验才操作用户应用，
// 界面验证使用独立资料目录的无头环境。
// macOS 取 mcp_servers.computer-use；Windows 取 computer-use 插件与 node_repl。
// computer use 逐应用授权经 --dangerously-bypass-approvals-and-sandbox 放行。

// LocalTools 只在拉起机器上发现工具；Build 保持纯函数。
func LocalTools(tool string, req Request) (Request, error) {
	if (tool != "codex" && tool != "claude") || req.CLI != nil {
		return req, nil
	}
	req.ComputerUse, req.ChromeURL = nil, ""
	home, err := os.UserHomeDir()
	if err != nil {
		return req, err
	}
	portFile := platform.ChromeActivePortPath(runtime.GOOS, home, os.Getenv("LOCALAPPDATA"), os.Getenv("XDG_CONFIG_HOME"))
	b, err := os.ReadFile(portFile)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return req, err
	}
	if err == nil {
		req.ChromeURL, err = ChromeBrowserURL(string(b))
		if err != nil {
			return req, fmt.Errorf("读 DevToolsActivePort：%w", err)
		}
	}
	if tool == "claude" {
		return req, nil
	}
	b, err = os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return req, err
	}
	req.ComputerUse, err = localOverrides(string(b), req.ChromeURL)
	return req, err
}

// ChromeBrowserURL 只读端口标记，不连接浏览器。
func ChromeBrowserURL(content string) (string, error) {
	first, _, _ := strings.Cut(content, "\n")
	port, err := strconv.Atoi(strings.TrimSpace(first))
	if err != nil || port < 1 || port > 65535 {
		return "", errors.New("端口须为 1–65535")
	}
	return fmt.Sprintf("http://127.0.0.1:%d", port), nil
}

func chromeMCP(url string) map[string]any {
	return map[string]any{"command": "npx", "args": []string{"-y", "chrome-devtools-mcp@latest", "--browser-url=" + url, "--no-usage-statistics"}}
}

// ComputerUseOverrides 仅取 computer use 的表；通用 TOML 库处理跨行值和带引号的键。
func ComputerUseOverrides(config string) ([]string, error) { return localOverrides(config, "") }

func localOverrides(config, chromeURL string) ([]string, error) {
	var raw map[string]any
	if err := toml.Unmarshal([]byte(config), &raw); err != nil {
		return nil, err
	}
	source := map[string]map[string]any{}
	for _, key := range []string{"mcp_servers", "plugins"} {
		source[key], _ = raw[key].(map[string]any)
	}
	return selectOverrides(source, chromeURL)
}

func selectOverrides(source map[string]map[string]any, chromeURL string) ([]string, error) {
	selected := map[string]map[string]any{}
	enabled := func(v any) bool { m, ok := v.(map[string]any); return ok && m["enabled"] != false }
	if enabled(source["mcp_servers"]["computer-use"]) || enabled(source["plugins"]["computer-use@openai-bundled"]) {
		for group, keys := range map[string][]string{"mcp_servers": {"computer-use", "node_repl"}, "plugins": {"computer-use@openai-bundled"}} {
			for _, key := range keys {
				if v, ok := source[group][key]; ok {
					if selected[group] == nil {
						selected[group] = map[string]any{}
					}
					selected[group][key] = v
				}
			}
		}
	}
	if chromeURL != "" {
		if selected["mcp_servers"] == nil {
			selected["mcp_servers"] = map[string]any{}
		}
		selected["mcp_servers"]["chrome-devtools"] = chromeMCP(chromeURL)
	}
	var out []string
	for _, group := range []string{"mcp_servers", "plugins"} {
		if selected[group] == nil {
			continue
		}
		var b bytes.Buffer
		if err := toml.NewEncoder(&b).SetTablesInline(true).Encode(map[string]any{group: selected[group]}); err != nil {
			return nil, err
		}
		out = append(out, strings.TrimSpace(b.String()))
	}
	return out, nil
}
