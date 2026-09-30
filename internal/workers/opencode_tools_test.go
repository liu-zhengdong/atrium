package workers

import (
	"encoding/json"
	"testing"
)

// 隔离不能靠覆盖进程级目录：shell 子进程仍须使用原有 gh/git 环境。
func TestOpencodePreservesChildEnvironment(t *testing.T) {
	for _, endpoint := range []*Endpoint{nil, {BaseURL: "https://example.invalid", API: "openai", KeyEnv: "TEST_KEY"}} {
		l, err := Build("opencode", Request{Dir: t.TempDir(), Prompt: "x", Model: "test", Endpoint: endpoint})
		if err != nil {
			t.Fatal(err)
		}
		for k := range l.Env {
			if k != "OPENCODE_CONFIG_CONTENT" {
				t.Fatalf("意外覆盖子进程环境：%s", k)
			}
		}
		if inOrder(l.Args, []string{"--pure"}) {
			t.Fatal("未隔离 MCP 时不另改插件行为")
		}
		if endpoint == nil {
			if len(l.Env) != 0 {
				t.Fatal(l.Env)
			}
			continue
		}
		var cfg struct {
			Provider map[string]any
			MCP      map[string]any
		}
		if err := json.Unmarshal([]byte(l.Env["OPENCODE_CONFIG_CONTENT"]), &cfg); err != nil {
			t.Fatal(err)
		}
		if len(cfg.Provider) != 1 || cfg.Provider["atrium"] == nil || len(cfg.MCP) != 0 {
			t.Fatal(cfg)
		}
	}
}
