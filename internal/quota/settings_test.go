package quota

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestQuotaSettingsWithoutOverview(t *testing.T) {
	data := t.TempDir()
	db, err := store.Open(filepath.Join(data, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	// 展示缓存故意损坏：设置不该再依赖或返回它。
	if _, err := db.ExecContext(ctx, `INSERT INTO quota_cache VALUES ('openquota','openquota','broken',?)`, store.Now()); err != nil {
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
	run := func(args ...string) (int, string) {
		var out, errOut bytes.Buffer
		code := tb.Main(ctx, args, cli.Env{Stdout: &out, Stderr: &errOut, Getenv: func(k string) string { return vars[k] }})
		return code, out.String() + errOut.String()
	}
	for _, args := range [][]string{{"quota"}, {"quota", "--help"}} {
		code, out := run(args...)
		if code != 0 || !strings.Contains(out, "OpenQuota/magpie") || strings.Contains(out, "各账号额度与富余") {
			t.Fatalf("%v: %d %s", args, code, out)
		}
	}
	for _, args := range [][]string{{"quota", "set", "--reserve", "35"}, {"quota", "set", "--reserve", "35", "--json"}} {
		code, out := run(args...)
		if code != 0 || strings.Contains(out, "lines") || strings.Contains(out, "富余") || !strings.Contains(out, "35") {
			t.Fatalf("%v: %d %s", args, code, out)
		}
		if strings.Contains(out, `"ok"`) {
			var envelope struct {
				Result map[string]json.RawMessage `json:"result"`
			}
			if err := json.Unmarshal([]byte(out), &envelope); err != nil || len(envelope.Result) != 1 || string(envelope.Result["reserve"]) != "35" {
				t.Fatalf("设置只能返回 reserve：%s %v", out, err)
			}
		}
	}
	for _, value := range []string{"-1", "91", "bad"} {
		if code, out := run("quota", "set", "--reserve", value); code == 0 || !strings.Contains(out, "--reserve") {
			t.Fatalf("坏参数未拒绝：%s %d %s", value, code, out)
		}
	}
	if reserve, err := Reserve(ctx, db); err != nil || reserve != 35 {
		t.Fatalf("坏输入改变设置：%d %v", reserve, err)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/api/quota", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed && resp.StatusCode != http.StatusNotFound {
		t.Fatalf("额度一览 API 仍可访问：%d", resp.StatusCode)
	}
	t.Log("组帮助指引、设置文本/JSON、坏参数拒绝与一览 API 退役均通过；损坏展示缓存不影响设置")
}
