package dispatch

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func TestQuotaAccountSelection(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}}
	oldPick, oldIsolated, oldSpares := pickHost, isolated, spares
	t.Cleanup(func() { pickHost, isolated, spares = oldPick, oldIsolated, oldSpares })
	pickHost = func(context.Context, *app.Env, HostNeed, string) (HostChoice, error) {
		return HostChoice{Kind: "run", Host: LocalHost}, nil
	}
	isolated = func(*app.Env) bool { return false } // 只测试选择，不拉起工具；机器事实也是假的。
	spares = quota.Spares
	src := "---\nprotocol: cli\ncommand: go\nargs: [\"{prompt}\"]\nauto: false\n---\n额度：无读数，只接点名派活。\n"
	if _, err := workers.SaveProfile(ctx, db, "harness/trae", workers.Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	d := &dispatcher{env: env}
	for _, tc := range []struct {
		body  string
		spare *float64
		stop  bool
	}{
		{`{"rows":[{"providerId":"antigravity","usedPercent":30,"periodElapsedPercent":50}]}`, f(20), false},
		{`{"rows":[{"providerId":"antigravity","usedPercent":90,"periodElapsedPercent":50}]}`, f(-40), true},
		{`{"rows":[{"providerId":"antigravity","usedPercent":30,"hoursToReset":2}]}`, nil, false},
	} {
		if _, err := db.ExecContext(ctx, `INSERT INTO quota_cache (account, tool, body, read_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(account) DO UPDATE SET body = excluded.body`, "openquota", "openquota", tc.body, store.Now()); err != nil {
			t.Fatal(err)
		}
		v, err := d.view(ctx, ledger.Task{}, "low", nil)
		if err != nil {
			t.Fatal(err)
		}
		foundAgy, foundTrae := false, false
		for _, c := range v.Candidates {
			switch {
			case strings.HasPrefix(c.ID, "agy+"):
				foundAgy = true
				if (c.Spare == nil) != (tc.spare == nil) || c.Spare != nil && *c.Spare != *tc.spare || c.Eligible == tc.stop {
					t.Fatalf("agy 的富余或留份额判定：%+v", c)
				}
			case c.ID == "trae":
				foundTrae = true
				if c.Eligible || c.Spare != nil || !strings.Contains(strings.Join(c.Refusals, "；"), "auto=false") {
					t.Fatalf("无读数的 trae 不应参与自动挑人：%+v", c)
				}
			}
		}
		if !foundAgy || !foundTrae {
			t.Fatalf("缺执行者：%+v", v)
		}
		if tc.spare != nil && !tc.stop && !strings.HasPrefix(v.Recommended, "agy+") {
			t.Fatalf("有富余的 agy 应排在无读数执行者前：%+v", v)
		}
	}
}
