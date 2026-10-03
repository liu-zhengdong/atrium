package web

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func TestLegionRetiredQuota(t *testing.T) {
	data := t.TempDir()
	db, err := store.Open(filepath.Join(data, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	env := &app.Env{DB: db, Paths: config.Paths{Data: data}}
	old := quota.DisabledAccounts
	defer func() { quota.DisabledAccounts = old }()
	workers.Routes(api.NewRouter(nil), env)
	ctx := context.Background()
	now := store.Now()
	// 下架账号即使仍有自带成功读数与 OpenQuota 读数，也不能占格子。
	if err := quota.Record(ctx, db, quota.LocalHost, []quota.Reading{
		{Account: "claude", OK: true, ReadAt: now, Windows: []quota.Window{{ID: "week", Used: 25, ResetsAt: now + 3600_000, Period: 3600}}},
		{Account: "opencode", Reason: "临时读不到", ReadAt: now},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO quota_cache (account, tool, body, read_at) VALUES (?, ?, ?, ?)", "openquota", "openquota", `{"rows":[{"providerId":"claude","usedPercent":30}]}`, now); err != nil {
		t.Fatal(err)
	}
	for _, enabled := range []bool{false, true, false} {
		src := "---\nauto: false\n---\n"
		if enabled {
			src = "---\nauto: true\n---\n"
		}
		if _, err := workers.SaveProfile(ctx, db, "harness/claude", workers.Edit{Source: &src}, "u1"); err != nil {
			t.Fatal(err)
		}
		legion, err := loadLegion(ctx, env, now)
		if err != nil {
			t.Fatal(err)
		}
		found, failed := false, false
		for _, a := range legion.Accounts {
			if a.Name == "claude" {
				found = true
			}
			if a.Name == "opencode" {
				failed = a.Left == nil && a.Note != ""
			}
		}
		if found != enabled || !failed || legion.Reserve != 20 {
			t.Fatalf("enabled=%v：%+v", enabled, legion.Quota)
		}
		body, _ := json.Marshal(legion.Quota)
		t.Logf("app.js renderLegion 对应数据 auto=%v：%s", enabled, body)
	}
}
