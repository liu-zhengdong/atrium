package hosts

import (
	"context"
	"path/filepath"
	"sync"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// 自检先写 clis、启动刷新后跑：刷新必须保留 clis（t933 同类，EnsureLocal 原先整体写 info 会抹掉）。
func TestEnsureLocalKeepsCLIs(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := EnsureLocal(ctx, db, Info{Hostname: "mac", OS: "darwin"}); err != nil {
		t.Fatal(err)
	}
	if err := setCLIs(ctx, db, Local, map[string]CLI{"go": {Version: "1.24", Installed: true}}); err != nil {
		t.Fatal(err)
	}
	if err := EnsureLocal(ctx, db, Info{Hostname: "mac", OS: "darwin", CPUs: 8, Version: "v2"}); err != nil {
		t.Fatal(err)
	}
	h, err := Get(ctx, db, Local)
	if err != nil {
		t.Fatal(err)
	}
	if h.Info == nil || h.Info.CLIs["go"].Version != "1.24" {
		t.Fatalf("启动刷新抹掉了自检的 clis：%+v", h.Info)
	}
	if h.Info.CPUs != 8 || h.Info.Version != "v2" {
		t.Fatalf("启动刷新没生效：%+v", h.Info)
	}
}

// EnsureLocal 与 setCLIs 交错并发：数据库事务串行加上各自字段级写，终态 clis 与刷新字段都应在。
func TestEnsureLocalRaceSelfCheck(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := EnsureLocal(ctx, db, Info{Hostname: "mac"}); err != nil {
		t.Fatal(err)
	}
	const rounds = 20
	errc := make(chan error, 2*rounds)
	for i := 0; i < rounds; i++ {
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			errc <- setCLIs(ctx, db, Local, map[string]CLI{"go": {Version: "1.24", Installed: true}})
		}()
		go func() {
			defer wg.Done()
			errc <- EnsureLocal(ctx, db, Info{Hostname: "mac", CPUs: 8})
		}()
		wg.Wait()
	}
	for i := 0; i < 2*rounds; i++ {
		if err := <-errc; err != nil {
			t.Fatal(err)
		}
	}
	h, err := Get(ctx, db, Local)
	if err != nil {
		t.Fatal(err)
	}
	if h.Info == nil {
		t.Fatal("机器 info 丢了")
	}
	cli, ok := h.Info.CLIs["go"]
	if !ok || cli.Version != "1.24" {
		t.Fatalf("并发后 clis 丢了：%+v", h.Info)
	}
	if h.Info.CPUs != 8 {
		t.Fatalf("并发后启动字段丢了：%+v", h.Info)
	}
}
