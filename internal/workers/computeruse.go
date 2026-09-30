package workers

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// claude、codex 执行者工具由 Atrium 显式给出，不继承用户个人 MCP：
// codex 带本机 computer use，关闭 ChatGPT apps；claude 仅带显式的 MCP。
// opencode、cursor、grok、kimi、agy 尚无保留子进程用户环境与登录、
// 且只加载给定 MCP 的已验证入口；仍读个人 MCP。
// opencode 1.18.32 的 CONFIG_DIR/CONFIG_CONTENT 追加或合并配置，不能隔离全局 MCP；
// 不改 XDG_CONFIG_HOME，以免 shell 子进程丢失 gh 配置与 git 凭据入口。
// 两者始终带 chrome-devtools MCP；入口持锁使用专用资料目录，被占时用 --isolated。
// computer use 操作本机应用；Browser 插件需要 Chrome 扩展，不带。
// 用户应用操作由 k26 管；界面验证使用临时资料目录的无头环境。
// macOS 取 mcp_servers.computer-use；Windows 取 computer-use 插件与 node_repl。
// computer use 逐应用授权经 --dangerously-bypass-approvals-and-sandbox 放行。

// LocalTools 只在拉起机器上发现工具；Build 保持纯函数。
func LocalTools(tool string, req Request) (Request, error) {
	if (tool != "codex" && tool != "claude") || req.CLI != nil {
		return req, nil
	}
	req.ComputerUse = nil
	if tool == "claude" {
		return req, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return req, err
	}
	b, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return req, err
	}
	req.ComputerUse, err = ComputerUseOverrides(string(b))
	return req, err
}

func chromeMCP() map[string]any {
	return map[string]any{"command": "atrium", "args": []string{"workers", "chrome-mcp"}}
}

// ComputerUseOverrides 仅取 computer use 的表；通用 TOML 库处理跨行值和带引号的键。
func ComputerUseOverrides(config string) ([]string, error) {
	var raw map[string]any
	if err := toml.Unmarshal([]byte(config), &raw); err != nil {
		return nil, err
	}
	source := map[string]map[string]any{}
	for _, key := range []string{"mcp_servers", "plugins"} {
		source[key], _ = raw[key].(map[string]any)
	}
	return selectOverrides(source)
}

func selectOverrides(source map[string]map[string]any) ([]string, error) {
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
	return encodeOverrides(selected)
}

func encodeOverrides(selected map[string]map[string]any) ([]string, error) {
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

// codexMCPOverrides 把显式 Chrome 与本机 computer use 合成同一份覆盖。
func codexMCPOverrides(computerUse []string) ([]string, error) {
	selected := map[string]map[string]any{}
	for _, config := range computerUse {
		if err := toml.Unmarshal([]byte(config), &selected); err != nil {
			return nil, err
		}
	}
	if selected["mcp_servers"] == nil {
		selected["mcp_servers"] = map[string]any{}
	}
	selected["mcp_servers"]["chrome-devtools"] = chromeMCP()
	return encodeOverrides(selected)
}
