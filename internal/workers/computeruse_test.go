package workers

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/pelletier/go-toml/v2"
	"reflect"
	"strings"
	"testing"
)

func TestComputerUseOverrides(t *testing.T) {
	// Windows 上 Codex 桌面版写的样子：computer-use 插件 + node_repl；别的表（含插件市场、Browser 插件）不带。
	win := `model = "gpt-6"
[plugins."computer-use@openai-bundled"]
enabled = true

[plugins."browser@openai-bundled"]
enabled = true

[marketplaces.openai-bundled]
source_type = "local"
source = '\\?\C:\Users\u\.codex\.tmp\bundled-marketplaces\openai-bundled'

[mcp_servers.semble]
command = "uvx"

[mcp_servers.node_repl]
args = []   # 行尾注释
command = 'C:\bin\node_repl.exe'

[mcp_servers.node_repl.env]
NODE_REPL_TRUSTED_SERVICES = '{"sky":"@oai/sky/service"}'
TAG = "a # 不是注释"
`
	cases := []struct {
		name, config string
		want         []string
		bad          string
	}{
		{name: "windows", config: win, want: []string{
			`plugins={"computer-use@openai-bundled"={enabled=true}}`,
			`mcp_servers={node_repl={args=[],command='C:\bin\node_repl.exe',env={NODE_REPL_TRUSTED_SERVICES='{"sky":"@oai/sky/service"}',TAG="a # 不是注释"}}}`,
		}},
		{name: "macos", config: "[ mcp_servers.computer-use ]\r\ncommand = \"/Applications/Codex.app/cu\"\r\nenabled = true\r\nenv . A = \"1\"\r\n", want: []string{
			`mcp_servers={computer-use={command="/Applications/Codex.app/cu",enabled=true,env={A="1"}}}`,
		}},
		// 装了但关着、或没装：node_repl 等一张也不带。
		{name: "关着", config: "[mcp_servers.computer-use]\nenabled = false\n[mcp_servers.node_repl]\ncommand = \"n\"\n"},
		{name: "没装", config: "[mcp_servers.node_repl]\ncommand = \"n\"\n[plugins.\"browser@openai-bundled\"]\nenabled = true\n"},
		{name: "跨行数组", config: "[mcp_servers.computer-use]\nargs = [\n  \"a\",\n]\n", want: []string{`mcp_servers={computer-use={args=["a"]}}`}},
		{name: "键重复", config: "[mcp_servers.computer-use]\ncommand = \"a\"\ncommand = \"b\"\n", bad: "already defined"},
		{name: "跨行字符串", config: "[mcp_servers.computer-use]\ncommand = \"\"\"\nx\n\"\"\"\n", want: []string{`mcp_servers={computer-use={command="x\n"}}`}},
	}
	for _, c := range cases {
		got, err := ComputerUseOverrides(c.config)
		if c.bad != "" {
			if err == nil || !strings.Contains(err.Error(), c.bad) {
				t.Errorf("%s：应报 %q，得到 %q %v", c.name, c.bad, got, err)
			}
			continue
		}
		if err != nil || !sameOverrides(got, c.want) {
			t.Errorf("%s：\n得到 %q %v\n应为 %q", c.name, got, err, c.want)
		}
	}
}

func TestLocalTools(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("LOCALAPPDATA", home)
	t.Setenv("XDG_CONFIG_HOME", home)
	req := Request{Prompt: "x", Dir: home, ComputerUse: []string{"wrong"}}
	// 没有 ~/.codex/config.toml：什么都不带。
	if got, err := LocalTools("codex", req); err != nil || got.ComputerUse != nil {
		t.Fatalf("没配置：%+v %v", got, err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "config.toml"), []byte("[mcp_servers.computer-use]\ncommand = \"cu\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := LocalTools("codex", req); err != nil || !sameOverrides(got.ComputerUse, []string{`mcp_servers={computer-use={command="cu"}}`}) {
		t.Errorf("codex：%q %v", got.ComputerUse, err)
	}
	// 别的工具不读 codex 的配置。
	if got, _ := LocalTools("claude", req); got.ComputerUse != nil {
		t.Errorf("claude 不应带：%q", got.ComputerUse)
	}
}

func sameOverrides(a, b []string) bool {
	decode := func(values []string) map[string]any {
		result := map[string]any{}
		for _, v := range values {
			var m map[string]any
			if toml.Unmarshal([]byte(v), &m) != nil {
				return nil
			}
			for k, v := range m {
				result[k] = v
			}
		}
		return result
	}
	return reflect.DeepEqual(decode(a), decode(b))
}

func TestUnifiedMCP(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	for _, tool := range []string{"codex", "claude"} {
		for _, computerUse := range []string{"", "[mcp_servers.computer-use]\ncommand=\"cu\""} {
			req, err := LocalTools(tool, Request{Dir: home, Prompt: "x"})
			if err != nil {
				t.Fatal(err)
			}
			req.ComputerUse, err = ComputerUseOverrides(computerUse)
			if err != nil {
				t.Fatal(err)
			}
			launch, err := Build(tool, req)
			if err != nil {
				t.Fatal(err)
			}
			var server map[string]any
			for i, arg := range launch.Args {
				if tool == "claude" && arg == "--mcp-config" {
					var config struct {
						Servers map[string]map[string]any `json:"mcpServers"`
					}
					if err := json.Unmarshal([]byte(launch.Args[i+1]), &config); err != nil {
						t.Fatal(err)
					}
					server = config.Servers["chrome-devtools"]
				}
				if tool == "codex" && arg == "-c" && strings.HasPrefix(launch.Args[i+1], "mcp_servers ") {
					var config struct {
						Servers map[string]map[string]any `toml:"mcp_servers"`
					}
					if err := toml.Unmarshal([]byte(launch.Args[i+1]), &config); err != nil {
						t.Fatal(err)
					}
					server = config.Servers["chrome-devtools"]
					if computerUse != "" && config.Servers["computer-use"]["command"] != "cu" {
						t.Fatal(config)
					}
				}
			}
			want := map[string]any{"command": "npx", "args": []any{"-y", "chrome-devtools-mcp@latest", "--no-usage-statistics"}}
			if !reflect.DeepEqual(server, want) {
				t.Fatalf("%s: %+v", tool, server)
			}
			if tool == "codex" && !strings.Contains(strings.Join(launch.Args, " "), "--disable apps") {
				t.Fatal(launch.Args)
			}
		}
	}
}

func TestCodexMCPOverrides(t *testing.T) {
	overrides, err := codexMCPOverrides([]string{`mcp_servers={node_repl={command="node"}}`, `plugins={"computer-use@openai-bundled"={enabled=true}}`})
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]map[string]any
	if err := toml.Unmarshal([]byte(strings.Join(overrides, "\n")), &config); err != nil {
		t.Fatal(err)
	}
	if config["mcp_servers"]["node_repl"] == nil || config["mcp_servers"]["chrome-devtools"] == nil || config["plugins"]["computer-use@openai-bundled"] == nil {
		t.Fatal(config)
	}
	if _, err := codexMCPOverrides([]string{"broken = ["}); err == nil {
		t.Fatal("损坏的覆盖应报错")
	}
}
