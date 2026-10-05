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

// 审阅任务回避拉起过被审任务的执行者：t877 第 4 轮派了 t856 的执行者去审，gates 判不合格，白跑一轮。
// 审阅轮挑人和点名均拒绝作者；所有候选均回避时写明原因。
func TestReviewRecusal(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Pause: &pause.Store{DB: db}}
	oldIsolated := isolated
	isolated = func(*app.Env) bool { return false } // 只测挑人，不拉起工具。
	t.Cleanup(func() { isolated = oldIsolated })
	// 内置只剩 dsh：用三份组合档案造出三个互不相同的审阅候选。
	if err := hosts.EnsureLocal(ctx, db, hosts.Info{CLIs: map[string]hosts.CLI{"dsh": {Installed: true}}}); err != nil {
		t.Fatal(err)
	}
	rev := []string{"dsh+rev1", "dsh+rev2", "dsh+rev3"}
	for _, name := range rev {
		src := "---\nmodel: rev/a" + strings.TrimPrefix(name, "dsh+rev") + "\ntrust: medium\n---\n"
		if _, err := workers.SaveProfile(ctx, db, "combos/"+name, workers.Edit{Source: &src}, "u1"); err != nil {
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
	launch(rev[0])
	launch(rev[1]) // 中途换人：两位都写过被审任务
	launch(rev[0])
	review := func() ledger.Task {
		t.Helper()
		launched, err := workers.Launched(ctx, db, src.ID)
		if err != nil {
			t.Fatal(err)
		}
		rt := src
		raw, _ := json.Marshal(gates.Requirement{MinTrust: "medium", NotWorkers: launched})
		if err := ledger.Record(ctx, db, rt.ID, gates.KindRequire, "gates", string(raw)); err != nil {
			t.Fatal(err)
		}
		return rt
	}
	d := get(env)

	rt := review()
	req, _ := requirement(ctx, db, rt.ID)
	if strings.Join(req.NotWorkers, ",") != "dsh+rev1,dsh+rev2" {
		t.Fatalf("回避名单应是拉起过的执行者去重：%v", req.NotWorkers)
	}
	v, err := d.view(ctx, rt, Options{Risk: "low"}, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if v.Recommended != "dsh+rev3" {
		t.Fatalf("应挑没拉起过被审任务的 dsh+rev3：%+v", v)
	}
	for _, c := range v.Candidates {
		if (c.ID == "dsh+rev1" || c.ID == "dsh+rev2") && (c.Eligible || !strings.Contains(strings.Join(c.Refusals, "、"), gates.RecusedWhy)) {
			t.Fatalf("%s 应因回避被排除：%+v", c.ID, c)
		}
	}
	w, err := workers.Resolve(ctx, db, "dsh+rev1")
	if err != nil {
		t.Fatal(err)
	}
	if why := reviewRefusal(req, w.ID, w.Spec.Tool, w.Spec.Model, w.Rules.EffectiveTrust()); !strings.Contains(why, gates.RecusedWhy) {
		t.Fatal(why)
	}
	launch(rev[2])
	rt = review()
	v, err = d.view(ctx, rt, Options{Risk: "low"}, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if v.Recommended != "" || !strings.Contains(v.Reason, "dsh+rev1、dsh+rev2、dsh+rev3 拉起过被审任务，审阅回避") {
		t.Fatalf("%+v", v)
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
