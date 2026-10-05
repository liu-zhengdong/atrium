package web

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 额度余量在 OpenQuota 与 magpie 看：存着读数时执行者页的数据和页面都不带余量。
func TestLegionShowsNoQuota(t *testing.T) {
	data := t.TempDir()
	db, err := store.Open(filepath.Join(data, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	env := &app.Env{DB: db, Paths: config.Paths{Data: data}}
	ctx := context.Background()
	now := store.Now()
	if err := quota.Record(ctx, db, quota.LocalHost, []quota.Reading{
		{Account: quota.MagpieAccount, OK: true, ReadAt: now, Windows: []quota.Window{{ID: "week", Used: 25, ResetsAt: now + 3600_000, Period: 3600}}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO quota_cache (account, tool, body, read_at) VALUES (?, ?, ?, ?)", "openquota", "openquota", `{"rows":[{"providerId":"codex","usedPercent":85}]}`, now); err != nil {
		t.Fatal(err)
	}
	src := "---\nauto: true\n---\n"
	if _, err := workers.SaveProfile(ctx, db, "harness/dsh", workers.Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	legion, err := loadLegion(ctx, env, now)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(legion)
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(body, &keys); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"accounts", "reserve", "quota"} {
		if _, ok := keys[k]; ok {
			t.Errorf("执行者页数据不应带 %s：%s", k, body)
		}
	}

	js, err := staticFS.ReadFile("static/app.js")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(js), "function renderLegion(")
	end := strings.Index(string(js), "\nconst outName")
	if start < 0 || end < start {
		t.Fatal("app.js 里找不到 renderLegion")
	}
	render := string(js[start:end])
	for _, gone := range []string{"<h2>额度", "d.accounts", "d.reserve", "brandMark"} {
		if strings.Contains(render, gone) {
			t.Errorf("执行者页不应再画额度：仍有 %q", gone)
		}
	}
	if !strings.Contains(render, "额度富余自动避让") || !strings.Contains(render, "OpenQuota") || !strings.Contains(render, "magpie") {
		t.Error("执行者页顶部要指引到 OpenQuota 与 magpie")
	}
}
