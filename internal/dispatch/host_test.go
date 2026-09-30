package dispatch

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func testLocalHost(t *testing.T, env *app.Env) {
	t.Helper()
	env.Pause = &pause.Store{DB: env.DB}
	clis := map[string]hosts.CLI{"fake": {Installed: true}}
	for _, name := range workers.Tools {
		clis[name] = hosts.CLI{Installed: true}
	}
	if err := hosts.EnsureLocal(context.Background(), env.DB, hosts.Info{CLIs: clis}); err != nil {
		t.Fatal(err)
	}
}

func TestRemoteCLISelection(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}, Pause: &pause.Store{DB: db}}
	if err := hosts.EnsureLocal(ctx, db, hosts.Info{}); err != nil {
		t.Fatal(err)
	}
	src := "---\nprotocol: cli\ncommand: remote-only-command\nargs: [\"{prompt}\"]\n---\n"
	if _, err := workers.SaveProfile(ctx, db, "harness/remote-cli", workers.Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	h, code, err := hosts.Add(ctx, db, hosts.AddInput{Name: "远程", Repos: []string{"*"}}, 4999)
	if err != nil {
		t.Fatal(err)
	}
	oldSpares := spares
	spares = func(context.Context, *app.Env) (map[string]Spare, error) { return map[string]Spare{}, nil }
	t.Cleanup(func() { spares = oldSpares })
	d := &dispatcher{env: env}
	for _, available := range []bool{true, false} {
		clis := map[string]hosts.CLI{}
		if available {
			clis["remote-cli"] = hosts.CLI{Installed: true}
		}
		if available {
			if _, _, err := hosts.Join(ctx, db, code, hosts.Info{CLIs: clis}); err != nil {
				t.Fatal(err)
			}
		} else {
			raw := `{"clis":{}}`
			if _, err := db.ExecContext(ctx, `UPDATE hosts SET info = ? WHERE id = ?`, raw, h.ID); err != nil {
				t.Fatal(err)
			}
		}
		v, err := d.view(ctx, ledger.Task{}, "low", nil)
		if err != nil {
			t.Fatal(err)
		}
		if available {
			if v.Recommended != "remote-cli" {
				t.Fatalf("远程可用应推荐：%+v", v)
			}
			c, err := hosts.Pick(ctx, env, hosts.Need{Tool: "remote-cli"}, "")
			if err != nil || c.Kind != "run" || c.Host != h.ID {
				t.Fatalf("应派到远程：%+v %v", c, err)
			}
		} else if v.Recommended != "" {
			t.Fatalf("远程不可用不应推荐：%+v", v)
		}
	}
}
