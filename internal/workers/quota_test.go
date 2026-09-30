package workers

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestShowWithStoredQuota(t *testing.T) {
	data := t.TempDir()
	db, err := store.Open(filepath.Join(data, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	env := &app.Env{DB: db, Paths: config.Paths{Data: data}}
	src := "---\nprotocol: cli\ncommand: trae\nauto: false\n---\n"
	if _, err := SaveProfile(ctx, db, "harness/trae", Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	now := store.Now()
	if err := quota.Record(ctx, db, quota.LocalHost, []quota.Reading{{Account: "claude", OK: true, ReadAt: now,
		Windows: []quota.Window{{ID: "week", Used: 25, ResetsAt: now + 84*3600_000, Period: 168 * 3600}}}}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ name, want string }{
		{"trae", "trae  没有额度读数"}, {"claude", "claude  富余 +25.0%"},
	} {
		d, err := showWithQuota(ctx, env, c.name)
		if err != nil {
			t.Fatal(err)
		}
		if d.Quota == nil || quotaText(*d.Quota) != c.want {
			t.Fatalf("%s：%+v", c.name, d.Quota)
		}
	}
	// 坏缓存必须报错，不能伪装成没有读数；查看原始档案无需读取额度。
	if _, err := db.ExecContext(ctx, "UPDATE quota_cache SET body = ?", "坏 JSON"); err != nil {
		t.Fatal(err)
	}
	if _, err := showWithQuota(ctx, env, "claude"); err == nil {
		t.Fatal("坏缓存应报错")
	}
	if d, err := showWithQuota(ctx, env, "harness/trae"); err != nil || d.Profile == nil || d.Quota != nil {
		t.Fatalf("原始档案：%+v %v", d, err)
	}
}

func TestQuotaDetail(t *testing.T) {
	zero, spare := 0.0, 12.5
	lines := []quota.Line{
		{Pace: quota.Pace{Account: "claude", UsedPercent: &zero, SparePercent: &spare}},
		{Pace: quota.Pace{Account: "antigravity", UsedPercent: &zero, SparePercent: &zero, Stale: true}},
		{Pace: quota.Pace{Account: "codex", UsedPercent: &zero}},
		{Pace: quota.Pace{Account: "kimi"}, Note: "读不到"},
	}
	for _, c := range []struct{ tool, want string }{
		{"trae", "trae  没有额度读数"},
		{"claude", "claude  富余 +12.5%"},
		{"agy", "antigravity  富余 +0.0%（旧读数）"},
		{"codex", "codex  有额度读数，富余未知"},
		{"kimi", "kimi  没有额度读数"},
	} {
		t.Run(c.tool, func(t *testing.T) {
			if got := quotaText(quotaFor(c.tool, lines)); got != c.want {
				t.Fatalf("得到 %q，期望 %q", got, c.want)
			}
		})
	}
}
