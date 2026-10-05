package dispatch

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func TestQuotaHostUnknownIdentitySelection(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}, Pause: &pause.Store{DB: db}}
	info := hosts.Info{CLIs: map[string]hosts.CLI{"dsh": {Installed: true}}}
	if err := hosts.EnsureLocal(ctx, db, info); err != nil {
		t.Fatal(err)
	}
	h, code, err := hosts.Add(ctx, db, hosts.AddInput{Name: "另一机器", Repos: []string{"*"}}, 4999)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := hosts.Join(ctx, db, code, info); err != nil {
		t.Fatal(err)
	}
	for _, host := range []string{LocalHost, h.ID} {
		used := 100.0
		finger := "first"
		if host != LocalHost {
			used = 0
			finger = "second"
		}
		if err := quota.Record(ctx, db, host, []quota.Reading{{Account: quota.MagpieAccount, OK: true, Plan: "Go", Finger: finger,
			ReadAt: store.Now(), Windows: []quota.Window{{ID: "month", Used: used}}}}); err != nil {
			t.Fatal(err)
		}
	}
	need := hosts.Need{Tool: "dsh", Model: "deepseek-official/deepseek-v4"}
	c, err := hosts.Pick(ctx, env, need, "")
	if err != nil || c.Kind != "run" || c.Host != LocalHost {
		t.Fatalf("未绑定额度不能凭缓存避开本机：%+v %v", c, err)
	}
	if err := workers.SetMark(ctx, db, workers.Mark{Tool: "dsh", Model: "deepseek-official/deepseek-v4", Host: LocalHost, Kind: workers.SignalQuota, Reason: "额度用尽", Since: store.Now(), Until: store.Now() + 10000}); err != nil {
		t.Fatal(err)
	}
	need.Model = "deepseek-official/deepseek-v4"
	c, err = hosts.Pick(ctx, env, need, LocalHost)
	if err != nil || c.Kind != "queue" {
		t.Fatalf("已失败组合在原机器不能再试，排队等恢复：%+v %v", c, err)
	}
	c, err = hosts.Pick(ctx, env, need, "")
	if err != nil || c.Kind != "run" || c.Host != h.ID {
		t.Fatalf("标记仍不能连坐另一机器：%+v %v", c, err)
	}
}
