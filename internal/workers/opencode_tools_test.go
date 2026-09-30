package workers

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestOpencodeTools(t *testing.T) {
	dir := t.TempDir()
	for _, chrome := range []string{"", "http://127.0.0.1:9222"} {
		for _, endpoint := range []*Endpoint{nil, {BaseURL: "https://example.invalid", API: "openai", KeyEnv: "TEST_KEY"}} {
			req := Request{Dir: dir, Prompt: "x", PromptFile: filepath.Join(dir, "prompt.md"), Model: "test", ChromeURL: chrome, Endpoint: endpoint}
			l, err := Build("opencode", req)
			if err != nil {
				t.Fatal(err)
			}
			root := req.PromptFile + ".opencode-config"
			for k, want := range map[string]string{"XDG_CONFIG_HOME": root, "OPENCODE_CONFIG_DIR": filepath.Join(root, "opencode"), "OPENCODE_TEST_HOME": root, "OPENCODE_DISABLE_PROJECT_CONFIG": "true", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true"} {
				if l.Env[k] != want {
					t.Fatalf("%s=%q want %q", k, l.Env[k], want)
				}
			}
			if !inOrder(l.Args, []string{"--pure"}) {
				t.Fatal(l.Args)
			}
			if _, ok := l.Env["XDG_DATA_HOME"]; ok {
				t.Fatal("不迁移登录数据")
			}
			var cfg struct {
				MCP map[string]struct {
					Type    string
					Command []string
				}
				Provider map[string]any
			}
			if err := json.Unmarshal([]byte(l.Env["OPENCODE_CONFIG_CONTENT"]), &cfg); err != nil {
				t.Fatal(err)
			}
			if chrome == "" {
				if len(cfg.MCP) != 0 {
					t.Fatal(cfg.MCP)
				}
			} else {
				c, ok := cfg.MCP["chrome-devtools"]
				if len(cfg.MCP) != 1 || !ok || c.Type != "local" || !inOrder(c.Command, []string{"npx", "-y", "chrome-devtools-mcp@latest", "--browser-url=" + chrome, "--no-usage-statistics"}) {
					t.Fatal(cfg.MCP)
				}
			}
			if (len(cfg.Provider) != 0) != (endpoint != nil) {
				t.Fatal(cfg.Provider)
			}
		}
	}
	if _, err := Build("opencode", Request{Dir: dir, Prompt: "x"}); err == nil {
		t.Fatal("缺少隔离路径应报错")
	}
}

func TestOpencodeConfigPerPrompt(t *testing.T) {
	dir := t.TempDir()
	first, err := Build("opencode", Request{Dir: dir, Prompt: "x", PromptFile: filepath.Join(dir, "first.md")})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Build("opencode", Request{Dir: dir, Prompt: "x", PromptFile: filepath.Join(dir, "second.md")})
	if err != nil {
		t.Fatal(err)
	}
	if first.Env["XDG_CONFIG_HOME"] == second.Env["XDG_CONFIG_HOME"] {
		t.Fatal("同一临时目录的两份请求不能共用工具配置")
	}
}
