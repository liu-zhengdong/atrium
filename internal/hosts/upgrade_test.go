package hosts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/release/selfupdate"
	"github.com/liu-zhengdong/atrium/internal/service"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// fakeGH 答 gh release download：往 -D 目录写本平台二进制（内容带版本）与对得上的 SHA256SUMS；fail 时报错。
type fakeGH struct {
	fail  bool
	calls []string
}

func (f *fakeGH) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	if f.fail {
		return "", errors.New("gh: 连不上 github.com")
	}
	out := args[len(args)-1]
	asset, bin := selfupdate.Asset(runtime.GOOS, runtime.GOARCH), []byte("new binary "+args[2])
	sum := sha256.Sum256(bin)
	if err := os.WriteFile(filepath.Join(out, selfupdate.SumsFile), []byte(hex.EncodeToString(sum[:])+"  "+asset+"\n"), 0o644); err != nil {
		return "", err
	}
	return "", os.WriteFile(filepath.Join(out, asset), bin, 0o644)
}

// upgradeRig：服务是发版版本 v2.0.91；代理数据目录是（临时主目录下的）缺省目录，算正式代理、会自升级。
func upgradeRig(t *testing.T) (*rig, string) {
	old := service.Version
	service.Version = "v2.0.91"
	t.Cleanup(func() { service.Version = old })
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("ATRIUM_UPDATE_REPO", "o/r")
	dir, err := AgentDir(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	return newRig(t), dir
}

// 代理旧于服务：hello 后下载服务的版本替换自身、以 ErrUpgraded 退出；在跑的执行者照跑，重起的代理重新跟进它、补报退出。
func TestAgentUpgradesToServer(t *testing.T) {
	g, dir := upgradeRig(t)
	exe := filepath.Join(t.TempDir(), "atrium")
	os.WriteFile(exe, []byte("old"), 0o755)
	a, stop, _ := g.agent(dir) // 与服务同版本：不升
	host := a.Cfg.Host
	g.task("t1")
	log := filepath.Join(g.env.Paths.Data, "t1.log")
	_, pid, _, err := Launch(context.Background(), g.env, host, Assignment{Task: "t1", Tool: "sleep", Request: workers.Request{Prompt: "x"}, Log: log})
	if err != nil {
		t.Fatal(err)
	}
	stop()
	// 换成旧版本的代理（h3 那样）：连上就升级、退出。
	gh := &fakeGH{}
	_, stop2, done := g.run(dir, func(a *Agent) { a.Version, a.Exe, a.GH = "v2.0.5", exe, gh })
	defer stop2()
	select {
	case err := <-done:
		if !errors.Is(err, ErrUpgraded) || !strings.Contains(err.Error(), "v2.0.5 → v2.0.91") {
			t.Fatalf("应以 ErrUpgraded 退出：%v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("旧代理没升级退出")
	}
	if len(gh.calls) != 1 || !strings.Contains(gh.calls[0], "release download v2.0.91 -R o/r") {
		t.Fatalf("应从服务的发版仓库下服务的版本：%v", gh.calls)
	}
	if raw, _ := os.ReadFile(exe); string(raw) != "new binary v2.0.91" {
		t.Fatalf("没换成服务的版本：%q", raw)
	}
	if raw, _ := os.ReadFile(exe + ".old"); string(raw) != "old" {
		t.Fatalf("旧文件应留作 .old：%q", raw)
	}
	if !platform.Alive(pid) {
		t.Fatal("升级不该带走在跑的执行者")
	}
	// 系统服务按新二进制重起代理：同版本，不再升；重新跟进执行者，补传日志、补报退出。
	_, stop3, _ := g.run(dir, func(a *Agent) { a.Exe, a.GH = exe, gh })
	defer stop3()
	g.waitOnline(host)
	if e := waitExit(t, g.env, "t1", 1); e.Lost {
		t.Fatalf("升级后应重新跟进执行者，不该按丢失收尾：%+v", e)
	}
	got, _ := os.ReadFile(log)
	if !strings.Contains(string(got), "睡") || !strings.Contains(string(got), "醒") {
		t.Fatalf("日志：%q", got)
	}
	if len(gh.calls) != 1 {
		t.Fatalf("同版本不该再下载：%v", gh.calls)
	}
}

// 升失败：发一条 online.failed（带机器）给秘书，本进程同一版本不再重试；隔离的代理、暂停时不升。
func TestAgentUpgradeFailsOnce(t *testing.T) {
	g, dir := upgradeRig(t)
	a, stop, _ := g.agent(t.TempDir()) // 登记一台拿令牌；隔离数据目录
	stop()
	ctx := context.Background()
	gh := &fakeGH{fail: true}
	iso := NewAgent(a.Dir, a.Cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	iso.Version, iso.GH = "v2.0.5", gh
	if err := iso.catchUp(ctx, "v2.0.91", "o/r", false); err != nil || len(gh.calls) != 0 {
		t.Fatalf("隔离的代理不该升：%v %v", err, gh.calls)
	}
	b := NewAgent(dir, a.Cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	b.Version, b.Exe, b.GH = "v2.0.5", filepath.Join(t.TempDir(), "atrium"), gh
	if err := b.catchUp(ctx, "v2.0.91", "o/r", true); err != nil || len(gh.calls) != 0 {
		t.Fatalf("暂停时不该升：%v %v", err, gh.calls)
	}
	for range 3 {
		if err := b.catchUp(ctx, "v2.0.91", "o/r", false); err != nil {
			t.Fatal(err)
		}
	}
	if len(gh.calls) != 1 {
		t.Fatalf("同一版本升失败不该重试：%v", gh.calls)
	}
	var n int
	var target, level, body string
	g.env.DB.QueryRow(`SELECT COUNT(*), MAX(target), MAX(level), MAX(body) FROM events WHERE kind = ?`, events.OnlineFailed).
		Scan(&n, &target, &level, &body)
	if n != 1 || target != events.Secretary || level != events.Act || !strings.Contains(body, `"host":"`+a.Cfg.Host+`"`) ||
		!strings.Contains(body, "连不上 github.com") {
		t.Fatalf("应给秘书发一条要处理、带机器的 online.failed：%d %s %s %s", n, target, level, body)
	}
}

// hello 回执带服务的版本、发版仓库与这台暂停没有。
func TestHelloCarriesVersion(t *testing.T) {
	g, _ := upgradeRig(t)
	a, stop, _ := g.agent(t.TempDir())
	stop()
	ctx := context.Background()
	hello := func() (r struct {
		Version, Repo string
		Paused        bool
	}) {
		if err := a.call(ctx, "/api/agent/hello", map[string]any{"info": Info{}, "runs": []AgentRun{}}, &r); err != nil {
			t.Fatal(err)
		}
		return r
	}
	if r := hello(); r.Version != "v2.0.91" || r.Repo != "o/r" || r.Paused {
		t.Fatalf("%+v", r)
	}
	if err := (&pause.Store{DB: g.env.DB}).Set(ctx, a.Cfg.Host, "u1"); err != nil {
		t.Fatal(err)
	}
	if r := hello(); !r.Paused {
		t.Fatalf("这台暂停了应带 paused：%+v", r)
	}
}
