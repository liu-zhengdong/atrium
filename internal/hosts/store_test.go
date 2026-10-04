package hosts

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// 启动刷新清掉上一进程留下的 clis：可用事实已过期，必须等本轮自检重报，
// 不能拿旧的「已安装」把任务在自检前派出去（dispatch 的 TestStartupProbeAutoDispatch
// 从分派侧钉同一个语义；这里从存储侧钉）。EnsureLocal 与自检在装配顺序上先后分明
// （serve.go 先跑完各模块 Routes 再起 Run），不构成 t933 那类并发覆盖。
func TestEnsureLocalRefreshClearsStaleCLIs(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// 上一进程的自检结论：startupfake 可用。
	if err := setCLIs(ctx, db, Local, map[string]CLI{"startupfake": {Installed: true}}); err != nil {
		t.Fatal(err)
	}
	// 本轮启动刷新：不带 clis，整体写 info。
	if err := EnsureLocal(ctx, db, Info{Hostname: "mac", OS: "darwin", CPUs: 8}); err != nil {
		t.Fatal(err)
	}
	h, err := Get(ctx, db, Local)
	if err != nil {
		t.Fatal(err)
	}
	if h.Info == nil || len(h.Info.CLIs) != 0 {
		t.Fatalf("启动刷新应清掉过期的 clis，留下：%+v", h.Info)
	}
	if h.Info.CPUs != 8 {
		t.Fatalf("启动刷新没生效：%+v", h.Info)
	}
}
