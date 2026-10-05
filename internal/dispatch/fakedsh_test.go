package dispatch

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// fakeDshOnPath 把测试二进制按 dsh 的名字放进临时 bin 并前插 PATH：回收、续做、自检这些
// 用例都拿它当唯一执行者，行为由 recoveryDsh 按档案里的模型名分派，不碰真实模型或本机登录。
func fakeDshOnPath(t *testing.T) {
	t.Helper()
	installFakeDsh(t, filepath.Join(t.TempDir(), "bin"))
}

// installFakeDsh 把测试二进制复制成 bin/dsh[.exe]（调用方自己管 PATH）。
func installFakeDsh(t *testing.T, bin string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(bin, 0700); err != nil {
		t.Fatal(err)
	}
	name := "dsh"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if err := os.WriteFile(filepath.Join(bin, name), raw, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// fakeCombo 写一份假 dsh 组合档案并返回标识：模型名里的模式由假执行者自己解释。
// 组合名带 -c 后缀，免得模型名跟组合名同名，被 Resolve 归一成「工具+provider/模型」。
func fakeCombo(t *testing.T, ctx context.Context, db *store.DB, mode, extra string) string {
	t.Helper()
	id := "dsh+" + mode + "-c"
	src := "---\nmodel: fake/" + mode + "\n" + extra + "---\n"
	if _, err := workers.SaveProfile(ctx, db, "combos/"+id, workers.Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	return id
}

// nonIsolated 关掉「隔离实例不自动挑内置工具」的判定：测试的组合档案指向假 dsh，
// 不碰真实执行者，但 dsh 是唯一内置工具，不关掉这条规则自动挑人全被拦。
func nonIsolated(t *testing.T) {
	t.Helper()
	old := isolated
	isolated = func(*app.Env) bool { return false }
	t.Cleanup(func() { isolated = old })
}
