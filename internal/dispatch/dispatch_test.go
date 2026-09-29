package dispatch

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func f(p float64) *float64 { return &p }

func TestPick(t *testing.T) {
	base := func() []Fact {
		return []Fact{
			{ID: "claude+opus", Tool: "claude", Account: "claude", Trust: "medium", MaxRisk: "medium", Installed: true},
			{ID: "codex+gpt", Tool: "codex", Account: "codex", Trust: "medium", MaxRisk: "medium", Installed: true},
			{ID: "opencode+m", Tool: "opencode", Account: "opencode", Trust: "unknown", MaxRisk: "low", Installed: true, Exclusive: true},
			{ID: "kimi", Tool: "kimi", Account: "kimi", Installed: false},
			{ID: "grok", Tool: "grok", Account: "grok", Installed: true, Refusal: "档案 max_risk=low，低于任务 risk=medium"},
		}
	}
	cases := []struct {
		name    string
		in      PickInput
		want    string
		reason  string
		waiting bool
	}{
		{name: "没数据按档案顺序", in: PickInput{Risk: "low", Facts: base()}, want: "claude+opus", reason: "没有额度数据"},
		{name: "富余多的在前", in: PickInput{Risk: "low", Facts: base(), Spares: map[string]Spare{
			"claude": {Percent: f(10)}, "codex": {Percent: f(50)}}}, want: "codex+gpt", reason: "富余最多（50.0"},
		{name: "富余为负也比没数据的靠前", in: PickInput{Risk: "low", Facts: base()[1:3], Spares: map[string]Spare{
			"codex": {Percent: f(-3.1)}}}, want: "codex+gpt", reason: "富余最多（-3.1"},
		{name: "见底与用尽不派", in: PickInput{Risk: "low", Facts: base(), Spares: map[string]Spare{
			"claude": {Percent: f(40), Stop: "额度见底"}, "codex": {Stop: "额度用尽"}}}, want: "opencode+m"},
		{name: "本机不可用不派", in: PickInput{Risk: "low", Facts: func() []Fact { b := base(); b[0].Unavailable = "本机不可用：额度用尽"; return b }()}, want: "codex+gpt"},
		{name: "紧急的活只给 trust≥medium，额度排序在这之后", in: PickInput{Risk: "low", Priority: ledger.Urgent, Facts: base(), Spares: map[string]Spare{
			"opencode": {Percent: f(90)}, "claude": {Percent: f(5)}, "codex": {Percent: f(1)}}}, want: "claude+opus", reason: "紧急的活只在 trust≥medium 的里挑"},
		{name: "修复的活同样", in: PickInput{Risk: "low", Priority: ledger.Fix, Facts: base()[2:3]}, reason: "修复的活要 trust≥medium，它是 unknown"},
		{name: "普通的活不限 trust", in: PickInput{Risk: "low", Priority: ledger.Normal, Facts: base()[2:3]}, want: "opencode+m"},
		{name: "独占正忙跳过", in: PickInput{Risk: "low", Facts: base()[2:3], Busy: map[string]bool{"opencode": true}}, waiting: true},
		{name: "试过的不再挑", in: PickInput{Risk: "low", Facts: base(), Exclude: map[string]bool{"claude+opus": true}}, want: "codex+gpt"},
		{name: "技能优先", in: func() PickInput {
			fs := base()
			fs[1].Preferred = 1
			return PickInput{Risk: "low", Facts: fs, Spares: map[string]Spare{"claude": {Percent: f(90)}}}
		}(), want: "codex+gpt", reason: "技能指定"},
		{name: "没人能接", in: PickInput{Risk: "medium", Facts: base()[3:]}, reason: "没有能接的执行者（kimi：没装"},
	}
	for _, c := range cases {
		v := Pick(c.in)
		if v.Recommended != c.want || v.Waiting != c.waiting || !strings.Contains(v.Reason, c.reason) {
			t.Errorf("%s：%+v", c.name, v)
		}
	}
	v := Pick(PickInput{Risk: "medium", Facts: base()})
	if v.Candidates[0].Rank != 1 || v.Candidates[len(v.Candidates)-1].Eligible {
		t.Errorf("能接的在前、不能接的在后：%+v", v.Candidates)
	}
}

func TestNeedTrust(t *testing.T) {
	cases := []struct {
		priority ledger.Priority
		risk     string
		want     string
	}{
		{ledger.Urgent, "low", "medium"},
		{ledger.Fix, "low", "medium"},
		{ledger.Normal, "low", ""},
		{ledger.Idle, "low", ""},
		{ledger.Normal, "medium", "medium"},
		{ledger.Idle, "high", "medium"},
		{"", "", ""},
	}
	for _, c := range cases {
		if got, why := NeedTrust(c.priority, c.risk); got != c.want || (got != "") != (why != "") {
			t.Errorf("NeedTrust(%s, %s) = %s %q，应为 %s", c.priority, c.risk, got, why, c.want)
		}
	}
}

func TestRouteExit(t *testing.T) {
	quota := workers.Signal{Kind: workers.SignalQuota, Reason: "额度用尽"}
	thinking := workers.Signal{Kind: workers.SignalThinking, Reason: "思考耗尽"}
	transient := workers.Signal{Kind: workers.SignalTransient, Reason: "临时错误"}
	cases := []struct {
		name string
		in   ExitInput
		want string
	}{
		{"正常退出交关卡", ExitInput{Code: 0}, "gate"},
		{"接管的进程按日志", ExitInput{Code: workers.ExitUnknown}, "gate"},
		{"退出码非 0", ExitInput{Code: 2}, "fail"},
		{"非 0 但日志正常收尾", ExitInput{Code: 1, Ending: workers.Ending{Known: true, OK: true}}, "gate"},
		{"报错收尾", ExitInput{Code: 0, Ending: workers.Ending{Known: true, Reason: "x"}}, "fail"},
		{"捎话要重派", ExitInput{Code: -1, StopFor: "restart"}, "restart"},
		{"额度用尽重新排队", ExitInput{Code: 1, Signal: quota, Switches: 2}, "requeue"},
		{"模型名无效重新排队", ExitInput{Code: 1, Signal: workers.Signal{Kind: workers.SignalModel, Reason: "模型名无效"}}, "requeue"},
		{"思考耗尽换人", ExitInput{Code: 0, Signal: thinking}, "switch"},
		{"思考耗尽换够了", ExitInput{Code: 0, Signal: thinking, Switches: 2}, "fail"},
		{"临时错误先重试", ExitInput{Code: 1, Signal: transient}, "same"},
		{"临时错误再换人", ExitInput{Code: 1, Signal: transient, Same: 1}, "switch"},
		{"临时错误用尽", ExitInput{Code: 1, Signal: transient, Same: 1, Switches: 2}, "fail"},
		{"没登录重新排队", ExitInput{Code: 1, Signal: workers.Signal{Kind: workers.SignalLogin, Reason: "没登录"}, Switches: 2}, "requeue"},
		{"有捎话能续上", ExitInput{Code: 0, Pending: 1, CanResume: true}, "resume"},
		{"有捎话不能续上", ExitInput{Code: 0, Pending: 2}, "restart"},
	}
	for _, c := range cases {
		if got := RouteExit(c.in); got.Do != c.want {
			t.Errorf("%s：%+v", c.name, got)
		}
	}
}

func TestTries(t *testing.T) {
	runs := []workers.Run{{Why: "first", Worker: "a"}, {Why: "same", Worker: "a"}, {Why: "first", Worker: "b"},
		{Why: "same", Worker: "b"}, {Why: "switch", Worker: "c"}, {Why: "resume", Worker: "c"}}
	same, sw, tried := tries(runs)
	if same != 1 || sw != 1 || !tried["b"] || !tried["c"] || tried["a"] {
		t.Fatalf("%d %d %v", same, sw, tried)
	}
}

func TestBuildPrompt(t *testing.T) {
	p := BuildPrompt(PromptInput{Task: "t3", Title: "修登录", Detail: "详述", Points: []string{"k1（o1）简洁——整体更简单"},
		Skill: "/data/skills/fix/SKILL.md", Profile: "先跑相关测试", Tells: []string{"改用 A 方案"}, Bounces: []string{"没有 PR"},
		Repo: "a/b", Branch: "task-t3", Guide: "不要用 git stash"})
	for _, want := range []string{"# 任务 t3：修登录", "- k1（o1）简洁——整体更简单", "/data/skills/fix/SKILL.md", "先跑相关测试",
		"- 改用 A 方案", "- 没有 PR", "分支 task-t3", "端到端验证", "隔离实例", "凭据不打印", "## 这个仓库的约定", "不要用 git stash"} {
		if !strings.Contains(p, want) {
			t.Errorf("提示词缺 %q：\n%s", want, p)
		}
	}
	if strings.Contains(p, "4310") || strings.Contains(p, "碰到哪些已有能力") {
		t.Errorf("通用约束不该写死某个仓库：\n%s", p)
	}
	p = BuildPrompt(PromptInput{Task: "t4", Title: "调研"})
	if strings.Contains(p, "只交 PR") || !strings.Contains(p, "没有仓库") || strings.Contains(p, "部门要点") || strings.Contains(p, "仓库的约定") {
		t.Errorf("没有仓库的提示词：\n%s", p)
	}
}

func TestRepoSource(t *testing.T) {
	d := t.TempDir() // 本机规则下的绝对路径：Windows 上 /src/app 没有盘符，不算绝对路径
	app := filepath.Join(d, "app")
	cases := []struct{ repo, local, url string }{
		{app, app, ""},
		{"owner/name", filepath.Join(d, "repos", "owner_name"), "https://github.com/owner/name.git"},
		{"file:///tmp/r.git", filepath.Join(d, "repos", "file_tmp_r.git"), "file:///tmp/r.git"},
	}
	for _, c := range cases {
		l, u, err := RepoSource(d, c.repo)
		if err != nil || l != c.local || u != c.url {
			t.Errorf("%s → %s %s %v", c.repo, l, u, err)
		}
	}
	for _, bad := range []string{"rel/../x", "just-a-name", "a/b/c"} {
		if _, _, err := RepoSource(d, bad); err == nil {
			t.Errorf("%s 应拒绝", bad)
		}
	}
}

func TestLineSignal(t *testing.T) {
	if r, _ := LineSignal(`{"type":"result","is_error":false}`); !r {
		t.Error("result")
	}
	if _, e := LineSignal(`{"type":"user","isReplay":true,"uuid":"tell-3"}`); e != "tell-3" {
		t.Error("echo")
	}
	if r, e := LineSignal(`{"type":"assistant","text":"\"type\":\"result\""}`); r || e != "" {
		t.Error("正文里的字样不算")
	}
}

func TestOptionsCheck(t *testing.T) {
	for _, o := range []Options{{Risk: "huge"}, {Host: "x1"}, {Secrets: []string{"lower"}}, {Secrets: []string{"ATRIUM_X"}}} {
		if err := o.check(); err == nil {
			t.Errorf("%+v 应拒绝", o)
		}
	}
	o := Options{}
	if err := o.check(); err != nil || o.Risk != "low" {
		t.Errorf("缺省 risk low：%+v %v", o, err)
	}
}

func TestHostLine(t *testing.T) {
	cases := map[[3]string]string{
		{"run", "h1", ""}:             "机器：在 h1 拉起",
		{"queue", "", "h1 同时最多跑 2 个"}: "机器：排队（h1 同时最多跑 2 个）",
		{"queue", "h2", "正忙"}:         "机器：排队等 h2（正忙）",
		{"refuse", "", "没有机器 h9"}:     "机器：接不了（没有机器 h9）",
	}
	for in, want := range cases {
		if got := hostLine(in[0], in[1], in[2]); got != want {
			t.Errorf("%v → %q", in, got)
		}
	}
}

func TestBounceCause(t *testing.T) {
	cases := []struct{ stage, note, want string }{
		{"merge_queue", "合入冲突：rebase 到 origin/main 时冲突", "冲突"},
		{"merge_queue", "快检查没过（rebase 到 origin/main 后跑 .agents/check）", "检查没过"},
		{"review", "审阅打回（t9，codex）：缺测试", "审阅打回"},
		{"accept", "验收打回（u1）：本地跑不起来", "验收打回"},
		{"gate", "关卡没过：没有 PR", "关卡没过"},
	}
	for _, c := range cases {
		if got := BounceCause(c.stage, c.note); got != c.want {
			t.Errorf("%s %q → %s", c.stage, c.note, got)
		}
	}
}

func TestRepoGuide(t *testing.T) {
	dir := t.TempDir()
	if g, err := repoGuide("/d", "a/b", dir); err != nil || g != "" {
		t.Fatalf("没有 .agents/README.md 不附：%q %v", g, err)
	}
	os.MkdirAll(filepath.Join(dir, ".agents"), 0o700)
	os.WriteFile(filepath.Join(dir, ".agents", "README.md"), []byte("本仓库约定"), 0o600)
	if g, err := repoGuide("/d", "a/b", dir); err != nil || g != "本仓库约定" {
		t.Fatalf("本机从工作树读：%q %v", g, err)
	}
	if g, err := repoGuide("/d", dir, ""); err != nil || g != "本仓库约定" {
		t.Fatalf("远程从本机克隆读：%q %v", g, err)
	}
	if g, _ := repoGuide("/d", "", dir); g != "" {
		t.Fatal("没有仓库不附")
	}
}
