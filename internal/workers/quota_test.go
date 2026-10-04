package workers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 额度余量在 OpenQuota 与 magpie 看：存着读数时 workers <名字> 也不写额度。
func TestShowWithoutQuota(t *testing.T) {
	data := t.TempDir()
	db, err := store.Open(filepath.Join(data, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	now := store.Now()
	if err := quota.Record(ctx, db, quota.LocalHost, []quota.Reading{{Account: "claude", OK: true, ReadAt: now,
		Windows: []quota.Window{{ID: "week", Used: 25, ResetsAt: now + 84*3600_000, Period: 168 * 3600}}}}); err != nil {
		t.Fatal(err)
	}
	r := api.NewRouter(nil)
	r.AddAuth(func(tok string) (api.Actor, bool) { return api.Actor{ID: "u1", Kind: "user"}, tok == "test-token" })
	Routes(r, &app.Env{DB: db, Paths: config.Paths{Data: data}})
	srv := httptest.NewServer(r)
	defer srv.Close()
	tb := cli.NewTable("atrium", "测试")
	Commands(tb)
	vars := map[string]string{"ATRIUM_WORKER_TOKEN": "test-token", "ATRIUM_SERVER": srv.URL}
	for _, args := range [][]string{{"workers", "claude+opus"}, {"workers", "claude+opus", "--json"}} {
		var out, errOut bytes.Buffer
		code := tb.Main(ctx, args, cli.Env{Stdout: &out, Stderr: &errOut, Getenv: func(k string) string { return vars[k] }})
		if code != 0 {
			t.Fatalf("%v：退出码 %d %s", args, code, errOut.String())
		}
		text := out.String()
		if !strings.Contains(text, "claude+opus") {
			t.Fatalf("%v：没有执行者详情：%s", args, text)
		}
		if strings.Contains(text, "额度：") || strings.Contains(text, "富余") {
			t.Errorf("%v：不应再写额度：%s", args, text)
		}
		var env struct {
			Result map[string]json.RawMessage `json:"result"`
		}
		if json.Unmarshal(out.Bytes(), &env) == nil && env.Result["quota"] != nil {
			t.Errorf("%v：详情不应带 quota：%s", args, text)
		}
	}
}

func TestResolvedAccount(t *testing.T) {
	for _, tc := range []struct{ tool, account string }{
		{"agy", "antigravity"}, {"claude", "claude"}, {"trae", "trae"}, {"fake", "fake"},
	} {
		for _, model := range []string{"", "model-a", "model-b"} {
			r := Resolved{Spec: Spec{Tool: tc.tool, Model: model}}
			if got := r.Account(); got != tc.account {
				t.Fatalf("%s：账号 %s，期望 %s", r.Spec, got, tc.account)
			}
		}
	}
	// 模型带 provider 前缀就归 provider，不限工具：claude+zcode/GLM-5.3[1m] 实际走 magpie 的 zcode，不记在 claude 名下。
	for _, tc := range []struct{ tool, model, cliModel, account string }{
		{"claude", "zcode/GLM-5.3[1m]", "", "zcode"},
		{"claude", "opus", "", "claude"},
		{"codex", "openai/gpt-5.3", "", "openai"},
		{"pi", "alias", "opencode-go/actual", "opencode-go"},
		{"pi", "zai/glm-4.6", "", "zai"},
		{"opencode", "zai/glm-4.6", "", "zai"},
	} {
		r := Resolved{Spec: Spec{Tool: tc.tool, Model: tc.model}, CLIModel: tc.cliModel}
		if got := r.Account(); got != tc.account {
			t.Fatalf("%s：账号 %s，期望 %s", r.Spec, got, tc.account)
		}
	}
}
