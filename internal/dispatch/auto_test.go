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

func TestNamedOnlyWorker(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}}
	testLocalHost(t, env)
	src := "---\nprotocol: cli\ncommand: go\nargs: [\"{prompt}\"]\nauto: false\n---\n"
	if _, err := workers.SaveProfile(ctx, db, "harness/fake", workers.Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	tk, err := ledger.Add(ctx, db, ledger.NewTask{Title: "只点名"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	d := get(env)
	v, err := d.view(ctx, tk, "low", nil)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range v.Candidates {
		if c.ID == "fake" {
			found = true
			if c.Eligible || !strings.Contains(strings.Join(c.Refusals, "；"), "档案 auto=false：只接点名分派任务") {
				t.Fatalf("自动候选：%+v", c)
			}
		}
	}
	if !found {
		t.Fatal("拒绝的执行者仍应列出")
	}
	w, wait, err := d.choose(ctx, tk, Options{Worker: "fake", Risk: "low"}, nil)
	if err != nil || wait || w.ID != "fake" {
		t.Fatalf("点名 choose：%+v %v %v", w, wait, err)
	}
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "fake", Risk: "low"}, "u1"); err != nil {
		t.Fatalf("点名入队：%v", err)
	}
	if _, _, err := d.choose(ctx, tk, Options{Worker: "fake", Risk: "low"}, map[string]bool{}); err == nil {
		t.Fatal("换人重试不能挑只点名执行者")
	}
	rows, err := workers.List(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if r.ID == "fake" && r.Auto {
			t.Fatal("列表应标只点名")
		}
	}
	if _, err := workers.SaveProfile(ctx, db, "harness/fake", workers.Edit{Unset: []string{"auto"}}, "u1"); err != nil {
		t.Fatal(err)
	}
	v, err = d.view(ctx, tk, "low", nil)
	if err != nil || v.Recommended != "fake" {
		t.Fatalf("缺省仍自动挑：%+v %v", v, err)
	}
}
