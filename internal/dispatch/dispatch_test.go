package dispatch

import (
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/workers"
)

func f(p float64) *float64 { return &p }

func TestPick(t *testing.T) {
	base := func() []Fact {
		return []Fact{
			{ID: "claude+opus", Tool: "claude", Account: "claude", Trust: "medium", MaxRisk: "medium", Installed: true},
			{ID: "codex+gpt", Tool: "codex", Account: "codex", Trust: "medium", MaxRisk: "medium", Installed: true},
			{ID: "opencode+m", Tool: "opencode", Account: "opencode", Installed: true, Exclusive: true},
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
			"claude": {Known: true, Room: 10}, "codex": {Known: true, Room: 50}}}, want: "codex+gpt", reason: "富余最多"},
		{name: "见底与用尽不派", in: PickInput{Risk: "low", Facts: base(), Spares: map[string]Spare{
			"claude": {Known: true, Room: 0, Reason: "已用满"}, "codex": {Held: true, Reason: "用尽"}}}, want: "opencode+m"},
		{name: "独占正忙跳过", in: PickInput{Risk: "low", Facts: base()[2:3], Busy: map[string]bool{"opencode": true}}, waiting: true},
		{name: "试过的不再挑", in: PickInput{Risk: "low", Facts: base(), Exclude: map[string]bool{"claude+opus": true}}, want: "codex+gpt"},
		{name: "技能优先", in: func() PickInput {
			fs := base()
			fs[1].Preferred = 1
			return PickInput{Risk: "low", Facts: fs, Spares: map[string]Spare{"claude": {Known: true, Room: 90}}}
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

func TestRouteExit(t *testing.T) {
	quota := workers.Signal{Kind: workers.SignalQuota, Reason: "额度用尽"}
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
		{"额度用尽换人", ExitInput{Code: 1, Signal: quota}, "switch"},
		{"额度用尽换够了", ExitInput{Code: 1, Signal: quota, Switches: 2}, "fail"},
		{"临时错误先重试", ExitInput{Code: 1, Signal: transient}, "same"},
		{"临时错误再换人", ExitInput{Code: 1, Signal: transient, Same: 1}, "switch"},
		{"临时错误用尽", ExitInput{Code: 1, Signal: transient, Same: 1, Switches: 2}, "fail"},
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
		Repo: "a/b", Branch: "task-t3"})
	for _, want := range []string{"# 任务 t3：修登录", "- k1（o1）简洁——整体更简单", "/data/skills/fix/SKILL.md", "先跑相关测试",
		"- 改用 A 方案", "- 没有 PR", "分支 task-t3", "端到端验证", "碰到哪些已有能力", "隔离实例", "凭据不打印"} {
		if !strings.Contains(p, want) {
			t.Errorf("提示词缺 %q：\n%s", want, p)
		}
	}
	p = BuildPrompt(PromptInput{Task: "t4", Title: "调研"})
	if strings.Contains(p, "只交 PR") || !strings.Contains(p, "没有仓库") || strings.Contains(p, "部门要点") {
		t.Errorf("没有仓库的提示词：\n%s", p)
	}
}

func TestRepoSource(t *testing.T) {
	cases := []struct{ repo, local, url string }{
		{"/src/app", "/src/app", ""},
		{"owner/name", "/d/repos/owner_name", "https://github.com/owner/name.git"},
		{"file:///tmp/r.git", "/d/repos/file_tmp_r.git", "file:///tmp/r.git"},
	}
	for _, c := range cases {
		l, u, err := RepoSource("/d", c.repo)
		if err != nil || l != c.local || u != c.url {
			t.Errorf("%s → %s %s %v", c.repo, l, u, err)
		}
	}
	for _, bad := range []string{"rel/../x", "just-a-name", "a/b/c"} {
		if _, _, err := RepoSource("/d", bad); err == nil {
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
