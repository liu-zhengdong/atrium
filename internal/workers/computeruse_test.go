package workers

import (
	"os"
	"path/filepath"

	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/pelletier/go-toml/v2"
	"reflect"
	"runtime"
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
	req := Request{Prompt: "x", Dir: home, ChromeURL: "http://wrong:1", ComputerUse: []string{"wrong"}}
	// 没有 ~/.codex/config.toml：什么都不带。
	if got, err := LocalTools("codex", req); err != nil || (got.ComputerUse != nil || got.ChromeURL != "") {
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

func TestChromeBrowserURL(t *testing.T) {
	for _, c := range []struct{ input, want string }{{"9222\n/devtools/browser/x\n", "http://127.0.0.1:9222"}, {"0", ""}, {"65536", ""}, {"bad", ""}, {"", ""}} {
		got, err := ChromeBrowserURL(c.input)
		if got != c.want || (err != nil) != (c.want == "") {
			t.Fatalf("%q: %q %v", c.input, got, err)
		}
	}
}

func TestUnifiedMCP(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("LOCALAPPDATA", home)
	t.Setenv("XDG_CONFIG_HOME", home)
	marker := platform.ChromeActivePortPath(runtime.GOOS, home, home, home)
	if err := os.MkdirAll(filepath.Dir(marker), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, []byte("9222\n/devtools/browser/test"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"codex", "claude"} {
		req, err := LocalTools(tool, Request{Dir: home, Prompt: "x"})
		if err != nil || req.ChromeURL != "http://127.0.0.1:9222" {
			t.Fatalf("%s: %+v %v", tool, req, err)
		}
		launch, err := Build(tool, req)
		if err != nil {
			t.Fatal(err)
		}
		args := strings.Join(launch.Args, " ")
		if !strings.Contains(args, "chrome-devtools") || !strings.Contains(args, "--browser-url=http://127.0.0.1:9222") {
			t.Fatalf("%s: %s", tool, args)
		}
		if tool == "codex" && !strings.Contains(args, "--disable apps") {
			t.Fatal(args)
		}
	}
	overrides, err := localOverrides("[mcp_servers.computer-use]\ncommand='cu'", "http://127.0.0.1:9222")
	if err != nil || len(overrides) != 1 || !strings.Contains(overrides[0], "computer-use") || !strings.Contains(overrides[0], "chrome-devtools") {
		t.Fatalf("%q %v", overrides, err)
	}
	if err := os.WriteFile(marker, []byte("not a port"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LocalTools("claude", Request{}); err == nil {
		t.Fatal("坏标记应报错")
	}
}
