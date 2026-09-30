package hosts

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func TestProbeFault(t *testing.T) {
	cases := []struct {
		name         string
		r            ProbeResult
		reason, keep string
	}{
		{"跑通", ProbeResult{Output: "codex-cli 0.157.1\n"}, "", ""},
		{"跑通但有杂讯也算通", ProbeResult{Output: "warning: x\n1.0\n"}, "", ""},
		{"非 0 退出，留前三行非空行", ProbeResult{Code: 1, Output: "\n No active Node.js version.\n\nRun nvm use\nl3\nl4\n"},
			"自检 codex --version 退出码 1", "No active Node.js version.；Run nvm use；l3"},
		{"超时", ProbeResult{TimedOut: true, Code: -1, Output: "starting"}, "自检 codex --version 20 秒没结束", "starting"},
		{"拉不起来", ProbeResult{Err: "exec format error"}, "自检 codex --version 拉不起来：exec format error", ""},
		{"没输出的非 0", ProbeResult{Code: 9009}, "自检 codex --version 退出码 9009", ""},
	}
	for _, c := range cases {
		reason, keep := ProbeFault("codex", c.r)
		if reason != c.reason || keep != c.keep {
			t.Errorf("%s：%q %q", c.name, reason, keep)
		}
	}
}

// 假工具是测试二进制自己（按文件名表现）：codex 跑通、opencode 报没选 Node 版本、claude 卡住；没放的不算。
func TestProbe(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	for _, n := range []string{"codex", "opencode", "claude"} {
		if err := os.WriteFile(filepath.Join(bin, n+suffix), raw, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	probeTools, probeTimeout = Tools, 2*time.Second
	defer func() { probeTools, probeTimeout = nil, 20*time.Second }()
	env := map[string]string{"PATH": bin, "HOSTS_FAKE_WORKER": "probe"}
	if runtime.GOOS == "windows" {
		env = map[string]string{"PATH": bin, "PATHEXT": ".EXE", "HOSTS_FAKE_WORKER": "probe", "SYSTEMROOT": os.Getenv("SYSTEMROOT")}
	}
	start := time.Now()
	got := Probe(context.Background(), env)
	if time.Since(start) > 10*time.Second {
		t.Errorf("各工具并行跑、超时就结束：用了 %s", time.Since(start))
	}
	byTool := map[string]ProbeFailure{}
	for _, f := range got {
		byTool[f.Tool] = f
	}
	if len(got) != 2 || byTool["opencode"].Reason != "自检 opencode --version 退出码 1" ||
		byTool["opencode"].Output != "No active Node.js version.；Run nvm use；line3" ||
		byTool["claude"].Reason != "自检 claude --version 2 秒没结束" {
		t.Fatalf("%+v", got)
	}
}

// 代理报上来的自检结果：不过的记成「工具@机器」不可用、挑机器跳过、workers 看得到原因；再报跑通就解除；不认识的工具名丢掉。
func TestAgentProbeRoute(t *testing.T) {
	g := newRig(t)
	a, stop, _ := g.agent(t.TempDir())
	defer stop()
	ctx := context.Background()
	host := a.Cfg.Host
	hostClient := &api.Client{Base: g.server.URL, Token: a.Cfg.Token}
	report := func(failed []ProbeFailure) {
		if err := hostClient.Do(ctx, "POST", "/api/agent/probe", map[string]any{"failed": failed}, nil); err != nil {
			t.Fatal(err)
		}
	}
	// 这台的 codex 看上去装了、登录了（上报的 CLIs），只有自检不过。
	info := Info{CLIs: map[string]CLI{"codex": {Installed: true}}}
	if err := touch(ctx, g.env.DB, host, &info, nil); err != nil {
		t.Fatal(err)
	}
	report([]ProbeFailure{{Tool: "codex", Reason: "自检 codex --version 退出码 1", Output: "No active Node.js version."}, {Tool: "evil", Reason: "x"}})
	marks, err := workers.Marks(ctx, g.env.DB, store.Now())
	if err != nil || len(marks) != 1 || marks[0].Target() != "codex@"+host || marks[0].Kind != workers.MarkProbe ||
		marks[0].Evidence != "No active Node.js version." {
		t.Fatalf("%+v %v", marks, err)
	}
	if c, err := Pick(ctx, g.env, Need{Tool: "codex"}, host); err != nil || c.Kind != "refuse" ||
		!strings.Contains(c.Reason, "自检 codex --version 退出码 1，自检跑通后自动解除") {
		t.Fatalf("%+v %v", c, err)
	}
	report(nil)
	if marks, _ := workers.Marks(ctx, g.env.DB, store.Now()); len(marks) != 0 {
		t.Fatalf("跑通后应解除：%+v", marks)
	}
	if c, err := Pick(ctx, g.env, Need{Tool: "codex"}, host); err != nil || c.Kind != "run" {
		t.Fatalf("%+v %v", c, err)
	}
}
