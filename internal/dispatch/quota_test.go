package dispatch

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func TestQuotaSummaryNotSelection(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}}
	oldPick, oldIsolated := pickHost, isolated
	t.Cleanup(func() { pickHost, isolated = oldPick, oldIsolated })
	pickHost = func(context.Context, *app.Env, HostNeed, string) (HostChoice, error) {
		return HostChoice{Kind: "run", Host: LocalHost}, nil
	}
	isolated = func(*app.Env) bool { return false } // 只测试选择，不拉起工具；机器事实也是假的。
	src := "---\nprotocol: cli\ncommand: go\nargs: [\"{prompt}\"]\nauto: false\n---\n额度：无读数，只接点名派活。\n"
	if _, err := workers.SaveProfile(ctx, db, "harness/trae", workers.Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	d := &dispatcher{env: env}
	for _, body := range []string{
		`{"rows":[{"providerId":"antigravity","usedPercent":30,"periodElapsedPercent":50}]}`,
		`{"rows":[{"providerId":"antigravity","usedPercent":90,"periodElapsedPercent":50}]}`,
		`{"rows":[{"providerId":"antigravity","usedPercent":30,"hoursToReset":2}]}`,
	} {
		if _, err := db.ExecContext(ctx, `INSERT INTO quota_cache (account, tool, body, read_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(account) DO UPDATE SET body = excluded.body`, "openquota", "openquota", body, store.Now()); err != nil {
			t.Fatal(err)
		}
		v, err := d.view(ctx, ledger.Task{}, Options{Risk: "low"}, nil, false)
		if err != nil {
			t.Fatal(err)
		}
		foundAgy, foundTrae := false, false
		for _, c := range v.Candidates {
			switch {
			case strings.HasPrefix(c.ID, "agy+"):
				foundAgy = true
				if c.Spare != nil || !c.Eligible {
					t.Fatalf("未绑定 provider 摘要不能作调度额度：%+v", c)
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

	}
}
