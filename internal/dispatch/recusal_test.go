package dispatch

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 审阅任务回避拉起过被审任务的执行者：t877 第 4 轮派了 t856 的执行者 codex 去审，gates 判不合格，白跑一轮。
// 有没拉起过的候选就挑它；点名拉起过的入队就拒；全被回避时转受阻，理由写明回避。
func TestReviewRecusal(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Pause: &pause.Store{DB: db}}
	clis := map[string]hosts.CLI{}
	for _, name := range []string{"rev1", "rev2", "rev3"} {
		clis[name] = hosts.CLI{Installed: true}
	}
	if err := hosts.EnsureLocal(ctx, db, hosts.Info{CLIs: clis}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"rev1", "rev2", "rev3"} {
		src := "---\nprotocol: cli\ncommand: go\nargs: [\"{prompt}\"]\ntrust: medium\n---\n"
		if _, err := workers.SaveProfile(ctx, db, "harness/"+name, workers.Edit{Source: &src}, "u1"); err != nil {
			t.Fatal(err)
		}
	}
	src, _ := ledger.Add(ctx, db, ledger.NewTask{Title: "被审"}, "u1")
	launch := func(worker string) {
		t.Helper()
		raw, _ := json.Marshal(workers.Run{Worker: worker, Why: workers.WhyFirst})
		if err := ledger.Record(ctx, db, src.ID, workers.RunKind, "dispatch", string(raw)); err != nil {
			t.Fatal(err)
		}
	}
	launch("rev1")
	launch("rev2") // 中途换人：两位都写过被审任务
	launch("rev1")
	review := func() ledger.Task {
		t.Helper()
		launched, err := workers.Launched(ctx, db, src.ID)
		if err != nil {
			t.Fatal(err)
		}
		rt, _ := ledger.Add(ctx, db, ledger.NewTask{Title: "审阅 " + src.ID, Parent: src.ID}, "gates")
		raw, _ := json.Marshal(gates.Requirement{NotTool: "claude", MinTrust: "medium", NotWorkers: launched})
		if err := ledger.Record(ctx, db, rt.ID, gates.KindRequire, "gates", string(raw)); err != nil {
			t.Fatal(err)
		}
		return rt
	}
	d := get(env)

	rt := review()
	req, _ := requirement(ctx, db, rt.ID)
	if strings.Join(req.NotWorkers, ",") != "rev1,rev2" {
		t.Fatalf("回避名单应是拉起过的执行者去重：%v", req.NotWorkers)
	}
	v, err := d.view(ctx, rt, Options{Risk: "low"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if v.Recommended != "rev3" {
		t.Fatalf("应挑没拉起过被审任务的 rev3：%+v", v)
	}
	for _, c := range v.Candidates {
		if (c.ID == "rev1" || c.ID == "rev2") && (c.Eligible || !strings.Contains(strings.Join(c.Refusals, "、"), gates.RecusedWhy)) {
			t.Fatalf("%s 应因回避被排除：%+v", c.ID, c)
		}
	}
	if _, err := Enqueue(ctx, env, rt.ID, Options{Worker: "rev1", Risk: "low"}, "a9"); err == nil || !strings.Contains(err.Error(), gates.RecusedWhy) {
		t.Fatalf("点名拉起过被审任务的执行者应拒绝入队：%v", err)
	}

	launch("rev3")
	rt = review()
	if _, err := Enqueue(ctx, env, rt.ID, Options{Risk: "low"}, "gates"); err != nil {
		t.Fatal(err)
	}
	if err := d.tryOnce(ctx, item{Task: mustGet(t, db, rt.ID), Opts: Options{Risk: "low"}}); err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, db, rt.ID)
	var note string
	db.QueryRowContext(ctx, `SELECT json_extract(body, '$.note') FROM task_events WHERE task = ? AND kind = 'block' ORDER BY id DESC LIMIT 1`, rt.ID).Scan(&note)
	if got.Status != ledger.Blocked || !strings.Contains(note, "没有能接的执行者") || !strings.Contains(note, "rev1、rev2、rev3 拉起过被审任务，审阅回避") {
		t.Fatalf("全被回避应转受阻并写明回避：%s %q", got.Status, note)
	}
}

func mustGet(t *testing.T, db *store.DB, id string) ledger.Task {
	t.Helper()
	tk, err := ledger.Get(context.Background(), db, id)
	if err != nil {
		t.Fatal(err)
	}
	return tk
}
