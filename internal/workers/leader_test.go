package workers

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/org/leaders"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 负责人的执行者组合与 task run --worker 同一种写法：导入的档案名（harness/claude 这样带层名）与旧库的组合
// claude+opus:high 对得上——登记时按 Resolve 核对，唤醒时按同一份档案翻成进程调用。
func TestLeaderComboResolves(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	src := "---\ntrust: medium\n---\n工具层叮嘱"
	if _, err := SaveProfile(ctx, db, "harness/claude", Edit{Source: &src}, "import"); err != nil {
		t.Fatal(err)
	}
	org.CheckWorker = func(ctx context.Context, q store.Querier, id string) error { _, err := Resolve(ctx, q, id); return err }
	t.Cleanup(func() { org.CheckWorker = nil })

	if _, err := org.AddLeader(ctx, db, org.NewLeader{Name: "坏组合", Workers: []string{"nosuch+x"}}); err == nil {
		t.Fatal("解析不了的执行者应拒绝登记")
	}
	a, err := org.AddLeader(ctx, db, org.NewLeader{Name: "Atrium 负责人", Workers: []string{"claude+opus:high"}})
	if err != nil {
		t.Fatal(err)
	}

	bin := t.TempDir()
	for _, n := range []string{"claude", "claude.exe"} {
		if err := os.WriteFile(filepath.Join(bin, n), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	env := map[string]string{platform.EnvKey(runtime.GOOS, "PATH"): bin, platform.EnvKey(runtime.GOOS, "PATHEXT"): ".EXE"}
	spec, err := LeaderSpec(ctx, &app.Env{DB: db}, leaders.Launch{Leader: a.ID, Profile: a.Workers[0], Prompt: "醒来", Dir: t.TempDir(), Env: env})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(spec.Args, "opus") {
		t.Fatalf("应按组合里的模型拉起：%v", spec.Args)
	}
}
