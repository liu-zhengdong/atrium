package dispatch

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func f(p float64) *float64 { return &p }

func TestPick(t *testing.T) {
	base := func() []Fact {
		return []Fact{
			{ID: "claude+opus", Tool: "claude", Account: "claude", Trust: "medium", MaxRisk: "medium"},
			{ID: "codex+gpt", Tool: "codex", Account: "codex", Trust: "medium", MaxRisk: "medium"},
			{ID: "opencode+m", Tool: "opencode", Account: "opencode", Trust: "unknown", MaxRisk: "low", Exclusive: true},
			{ID: "kimi", Tool: "kimi", Account: "kimi", Unavailable: "没有可用主机"},
			{ID: "grok", Tool: "grok", Account: "grok", Refusal: "档案 max_risk=low，低于任务 risk=medium"},
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
		{name: "没人能接", in: PickInput{Risk: "medium", Facts: base()[3:]}, reason: "没有能接的执行者（kimi：没有可用主机"},
		{name: "近 5 次启动失败 2 次往后排", in: PickInput{Risk: "low", Facts: func() []Fact { b := base(); b[0].Fails = 2; return b }()},
			want: "codex+gpt", reason: "claude+opus 近 5 次拉起启动失败 2 次，排在后面"},
		{name: "失败 1 次不影响", in: PickInput{Risk: "low", Facts: func() []Fact { b := base(); b[0].Fails = 1; return b }()},
			want: "claude+opus", reason: "没有额度数据"},
		{name: "往后排压过技能优先与富余", in: func() PickInput {
			fs := base()
			fs[0].Preferred, fs[0].Fails = 1, 3
			return PickInput{Risk: "low", Facts: fs, Spares: map[string]Spare{"claude": {Percent: f(90)}, "codex": {Percent: f(5)}}}
		}(), want: "codex+gpt", reason: "富余最多（5.0"},
		{name: "都不稳照常挑并写明", in: PickInput{Risk: "low", Facts: func() []Fact {
			b := base()[:2]
			b[0].Fails, b[1].Fails = 2, 4
			return b
		}()}, want: "claude+opus", reason: "它近 5 次拉起启动失败 2 次，但没有更稳的能接"},
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
	shaky := base()
	shaky[0].Fails = 2
	v = Pick(PickInput{Risk: "low", Facts: shaky})
	if v.Candidates[2].ID != "claude+opus" || v.Candidates[2].Rank != 3 || !v.Candidates[2].Eligible || v.Candidates[2].Fails != 2 {
		t.Errorf("近期启动失败多的排在能接的最后、仍能接：%+v", v.Candidates)
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
		{"正常退出进入交付检查", ExitInput{Code: 0}, "gate"},
		{"继续跟进的进程按日志", ExitInput{Code: workers.ExitUnknown}, "gate"},
		{"退出码非 0", ExitInput{Code: 2}, "fail"},
		{"非 0 但日志正常收尾", ExitInput{Code: 1, Ending: workers.Ending{Known: true, OK: true}}, "gate"},
		{"报错收尾", ExitInput{Code: 0, Ending: workers.Ending{Known: true, Reason: "x"}}, "fail"},
		{"补充说明要重派", ExitInput{Code: -1, StopFor: "restart"}, "restart"},
		{"额度用尽换人", ExitInput{Code: 1, Signal: quota}, "switch"},
		{"额度用尽换够后受阻", ExitInput{Code: 1, Signal: quota, Switches: 2}, "block"},
		{"模型名无效换人", ExitInput{Code: 1, Signal: workers.Signal{Kind: workers.SignalModel, Reason: "模型名无效"}}, "switch"},
		{"思考耗尽换人", ExitInput{Code: 0, Signal: thinking}, "switch"},
		{"思考耗尽换够了", ExitInput{Code: 0, Signal: thinking, Switches: 2}, "fail"},
		{"临时错误先重试", ExitInput{Code: 1, Signal: transient}, "same"},
		{"临时错误再换人", ExitInput{Code: 1, Signal: transient, Same: 1}, "switch"},
		{"临时错误用尽", ExitInput{Code: 1, Signal: transient, Same: 1, Switches: 2}, "fail"},
		{"零步骤出错退出换人", ExitInput{Code: 1, Signal: workers.Signal{Kind: workers.SignalNoStart, Reason: "零步骤出错退出（退出码 1，原因不明）"}}, "switch"},
		{"没登录换够后受阻", ExitInput{Code: 1, Signal: workers.Signal{Kind: workers.SignalSetup, Reason: "没登录"}, Switches: 2}, "block"},
		{"有补充说明能继续", ExitInput{Code: 0, Pending: 1, CanResume: true}, "resume"},
		{"有补充说明不能继续", ExitInput{Code: 0, Pending: 2}, "restart"},
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
	p := BuildPrompt(PromptInput{Task: "t3", Org: "o2", Title: "修登录", Detail: "详述", Global: "## 用户的全局原则\n\n先给结论\n", Points: []string{"k1（o1）简洁——整体更简单"},
		Skill: "fix", Skills: "## 技能索引（Atrium 全部技能）\n\n- web：网页\n", Profile: "先跑相关测试", Bounces: []string{"没有 PR"},
		Repo: "a/b", Branch: "task-t3", Guide: "不要用 git stash"})
	for _, want := range []string{"# 任务 t3：修登录", "- k1（o1）简洁——整体更简单", "先跑相关测试", "atrium material ls mN 取正文",
		"- 没有 PR", "分支 task-t3", "端到端验证", "隔离实例", "凭据不打印", "## 这个仓库的约定", "不要用 git stash", "atrium material add o2 <目录>", "`交付结论：完成`"} {
		if !strings.Contains(p, want) {
			t.Errorf("提示词缺 %q：\n%s", want, p)
		}
	}
	if !strings.HasPrefix(p, "# 任务 t3：修登录\n\n"+langRule+"\n") {
		t.Errorf("语言要求要紧跟标题：\n%s", p)
	}
	if !strings.Contains(p, "详述\n\n## 用户的全局原则\n\n先给结论\n\n## 部门要点") {
		t.Errorf("全局原则要在详述之后、部门要点之前：\n%s", p)
	}
	if !strings.Contains(p, "按这份做法干：atrium skill ls fix 取做法与附属文件\n\n## 技能索引（Atrium 全部技能）\n\n- web：网页\n\n## 给这个执行者的叮嘱") {
		t.Errorf("技能索引要紧跟挂上的技能、在执行者叮嘱之前：\n%s", p)
	}
	if strings.Contains(p, "4310") || strings.Contains(p, "碰到哪些已有能力") {
		t.Errorf("通用约束不该写死某个仓库：\n%s", p)
	}
	p = BuildPrompt(PromptInput{Task: "t4", Title: "调研"})
	if strings.Contains(p, "只交 PR") || !strings.Contains(p, "没有仓库") || !strings.Contains(p, "`交付结论：没做成`") || strings.Contains(p, "部门要点") || strings.Contains(p, "仓库的约定") ||
		strings.Contains(p, "material add") || !strings.Contains(p, "交不了资料") || strings.Contains(p, "## 技能") {
		t.Errorf("没有仓库的提示词：\n%s", p)
	}
	if r := ResumePrompt([]string{"改用 B"}); !strings.Contains(r, "- 改用 B") || !strings.Contains(r, langRule) {
		t.Errorf("继续的补充：\n%s", r)
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
		{"gate", "交付检查未通过：没有 PR", "交付检查未通过"},
	}
	for _, c := range cases {
		if got := BounceCause(c.stage, c.note); got != c.want {
			t.Errorf("%s %q → %s", c.stage, c.note, got)
		}
	}
}

// 交回的任务（没有队列行）沿用上一轮的执行者与机器：t421 写死在 h3 上干，交回后被自动挑机换到了 h1。
func TestQueuedBounceKeepsHost(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	tk, _ := ledger.Add(ctx, db, ledger.NewTask{Title: "在 h3 装工具", Repo: "o/r"}, "u1")
	for _, k := range []ledger.EventKind{ledger.Enqueue, ledger.Start} {
		if _, err := ledger.Apply(ctx, db, tk.ID, ledger.Event{Kind: k}, "dispatch", ""); err != nil {
			t.Fatal(err)
		}
	}
	ledger.Record(ctx, db, tk.ID, workers.RunKind, "dispatch", `{"n":1,"why":"first","worker":"claude+opus","host":"h3","risk":"medium","secrets":["DEMO_TOKEN"]}`)
	for _, k := range []ledger.EventKind{ledger.ExitOK, ledger.Bounce} {
		if _, err := ledger.Apply(ctx, db, tk.ID, ledger.Event{Kind: k}, "gates", "交付检查未通过"); err != nil {
			t.Fatal(err)
		}
	}
	items, err := queued(ctx, db)
	if err != nil || len(items) != 1 {
		t.Fatalf("队列：%+v %v", items, err)
	}
	want := Options{Worker: "claude+opus", Risk: "medium", Host: "h3", Secrets: []string{"DEMO_TOKEN"}}
	if got := items[0]; got.Row || got.Opts.Host != want.Host || got.Opts.Worker != want.Worker || got.Opts.Risk != want.Risk || !slices.Equal(got.Opts.Secrets, want.Secrets) {
		t.Fatalf("交回应沿用上一轮：%+v，期望 %+v", got, want)
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

func TestChildGate(t *testing.T) {
	kid := func(id string, s ledger.Status) ledger.Task { return ledger.Task{ID: id, Status: s} }
	for name, c := range map[string]struct {
		open []ledger.Task // 新的在前（与 ledger.List 一致）
		next string        // 空表示放行
		text string
	}{
		"没有子任务":          {nil, "", ""},
		"派最早一件能派的子任务":    {[]ledger.Task{kid("t9", ledger.Todo), kid("t8", ledger.Running), kid("t7", ledger.Blocked)}, "atrium task run t7", "3 件子任务没结束（t7 blocked、t8 running、t9 todo）"},
		"失败的子任务也能再派":     {[]ledger.Task{kid("t8", ledger.Failed), kid("t7", ledger.Queued)}, "atrium task run t8", "t7 queued、t8 failed"},
		"都在排队、在跑或草稿看任务树": {[]ledger.Task{kid("t8", ledger.Draft), kid("t7", ledger.Running)}, "atrium task tree t1", "task set t1 --status done"},
		"多了只列前五件":        {[]ledger.Task{kid("t7", ledger.Todo), kid("t6", ledger.Todo), kid("t5", ledger.Todo), kid("t4", ledger.Todo), kid("t3", ledger.Todo), kid("t2", ledger.Todo)}, "atrium task run t2", "6 件子任务没结束（t2 todo、t3 todo、t4 todo、t5 todo、t6 todo 等）"},
	} {
		err := childGate("t1", c.open)
		if c.next == "" {
			if err != nil {
				t.Errorf("%s：应放行，收到 %v", name, err)
			}
			continue
		}
		var ae *api.Error
		if !errors.As(err, &ae) || ae.Next != c.next || !strings.Contains(ae.Message, c.text) {
			t.Errorf("%s：%+v，应为 next=%q 含 %q", name, ae, c.next, c.text)
		}
	}
}

// 隔离实例自动挑人不挑内置工具（冒烟、测试不拉起本机真实执行者）；通用命令行执行者照挑；用户的服务照常挑内置工具。
func TestViewIsolated(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "data", "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	env := &app.Env{DB: db, Paths: config.Paths{Data: filepath.Join(dir, "data")}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Pause: &pause.Store{DB: db}}
	// 执行者令牌以用户令牌为签名钥匙：服务启动时写好，测试里自己写。
	if err := os.WriteFile(env.Paths.Token(), []byte("test-user-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	testLocalHost(t, env)
	oldSpares := spares
	spares = func(context.Context, *app.Env) (map[string]Spare, error) { return map[string]Spare{}, nil }
	t.Cleanup(func() { spares = oldSpares })
	src := "---\nprotocol: cli\ncommand: go\nargs: [\"{prompt}\"]\n---\n"
	if _, err := workers.SaveProfile(ctx, db, "harness/fake", workers.Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	tk, _ := ledger.Add(ctx, db, ledger.NewTask{Title: "巡检"}, "u1")
	d := get(env)
	refused := func(v PickView, id string) bool {
		for _, c := range v.Candidates {
			if strings.HasPrefix(c.ID, id) {
				return strings.Contains(strings.Join(c.Refusals, "、"), "隔离实例")
			}
		}
		t.Fatalf("候选里没有 %s：%+v", id, v.Candidates)
		return false
	}
	if !env.Paths.Isolated() {
		t.Fatal("临时目录应算隔离实例")
	}
	v, err := d.view(ctx, tk, "low", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range workers.Tools {
		if !refused(v, tool) {
			t.Errorf("隔离实例不该自动挑 %s：%+v", tool, v.Candidates)
		}
	}
	if refused(v, "fake") || v.Recommended != "fake" {
		t.Errorf("通用命令行执行者应照挑：%+v", v)
	}
	oldIsolated := isolated
	isolated = func(*app.Env) bool { return false }
	t.Cleanup(func() { isolated = oldIsolated })
	if v, err = d.view(ctx, tk, "low", nil); err != nil || refused(v, "claude") {
		t.Errorf("用户的服务照常挑内置工具：%+v %v", v, err)
	}
}

// 补充说明、改说明给交给负责人拆着的任务：发给负责人一条要处理的 task.assigned（带补充原文），没取走时再来合并成一条；
// 负责人自己捎、自己改不投。t442 交给 a7 后秘书改了说明，a7 什么也没收到。
func TestTellLeader(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	env := &app.Env{DB: db, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Pause: &pause.Store{DB: db}}
	for _, q := range []string{
		`INSERT INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0)`,
		`INSERT INTO departments (id, parent, name, leader, created_at, updated_at) VALUES ('o1', NULL, '一', 'a1', 0, 0)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	old := ledger.Tell
	hook(env)
	t.Cleanup(func() { ledger.Tell = old })
	type row struct {
		Target, Level, Body string
		Count               int
	}
	pending := func(id string) []row {
		t.Helper()
		rows, err := db.Query(`SELECT target, level, body, count FROM events WHERE task = ? AND kind = ? AND acked_at IS NULL ORDER BY id`, id, events.TaskAssigned)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []row
		for rows.Next() {
			var r row
			rows.Scan(&r.Target, &r.Level, &r.Body, &r.Count)
			out = append(out, r)
		}
		return out
	}
	goal, _ := ledger.Add(ctx, db, ledger.NewTask{Title: "拆分任务", Owner: "a1"}, "secretary")
	db.Exec(`UPDATE events SET acked_at = 1 WHERE task = ?`, goal.ID) // 负责人已接走交来的那条

	r, err := Tell(ctx, env, goal.ID, "用户又说：也要改网页", "secretary")
	if err != nil || r.Via != "leader" {
		t.Fatalf("应发给负责人：%+v %v", r, err)
	}
	got := pending(goal.ID)
	if len(got) != 1 || got[0].Target != "a1" || got[0].Level != events.Act || !strings.Contains(got[0].Body, `"tell":"用户又说：也要改网页"`) {
		t.Fatalf("负责人应收到一条要处理的、带补充原文的 task.assigned：%+v", got)
	}
	// 还没取走时改说明：走同一条路，合并成一条，正文换成最新的。
	detail := "新说明"
	if _, err := ledger.Edit(ctx, db, goal.ID, ledger.Patch{Detail: &detail}, "secretary"); err != nil {
		t.Fatal(err)
	}
	got = pending(goal.ID)
	if len(got) != 1 || got[0].Count != 2 || !strings.Contains(got[0].Body, `说明已改，以最新说明为准：\n新说明`) {
		t.Fatalf("没取走时应合并成一条最新的：%+v", got)
	}
	// 负责人自己捎、自己改：不发给自己。
	if _, err := Tell(ctx, env, goal.ID, "记一笔", "a1"); err != nil {
		t.Fatal(err)
	}
	detail = "负责人补的"
	if _, err := ledger.Edit(ctx, db, goal.ID, ledger.Patch{Detail: &detail}, "a1"); err != nil {
		t.Fatal(err)
	}
	if got = pending(goal.ID); len(got) != 1 || got[0].Count != 2 {
		t.Fatalf("负责人本人操作不投：%+v", got)
	}
	h, _ := ledger.History(ctx, db, goal.ID, 20)
	n := 0
	for _, e := range h {
		if e.Kind == "tell" {
			n++
		}
	}
	if n != 3 {
		t.Fatalf("补充说明都记进经历（两次补充说明、一次改说明）：%d", n)
	}
}

// 执行者日志有认不出的事件：退出时记一条组织发现草稿；同一工具还没结束的不再记，别的工具另记；草稿满了报错。
func TestNoteUnknown(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	log := filepath.Join(dir, "run-1.log")
	os.WriteFile(log, []byte(`{"type":"system","subtype":"init","cwd":"/r"}
{"type":"brand_new","x":1}
{"type":"brand_new","x":2}
{"type":"brand_new","x":3}
`), 0o600)
	dept := must(org.Add(ctx, db, org.NewDept{Name: "网页"}))
	tk := must(ledger.Add(ctx, db, ledger.NewTask{Title: "改帮助中心", Org: dept.ID}, "u1"))
	drafts := func() []ledger.Task {
		return must(ledger.List(ctx, db, ledger.Filter{Class: workers.ParseClass, Status: []ledger.Status{ledger.Draft}}))
	}
	for range 2 {
		if err := noteUnknown(ctx, db, tk.ID, workers.Run{Worker: "cursor+auto", Log: log}); err != nil {
			t.Fatal(err)
		}
	}
	got := drafts()
	if len(got) != 1 || got[0].Title != "cursor 日志有认不出的事件（"+tk.ID+"）" || got[0].Source != ledger.SourceOrg ||
		!strings.Contains(got[0].Detail, "有 3 行事件认不出") || !strings.Contains(got[0].Detail, `{"type":"brand_new","x":2}`) ||
		strings.Contains(got[0].Detail, `"x":3`) {
		t.Fatalf("同一工具只记一条，详述带行数与前两行：%+v", got)
	}
	// 认得出的日志、纯文本工具不记。
	if err := noteUnknown(ctx, db, tk.ID, workers.Run{Worker: "my-cli", Log: log}); err != nil || len(drafts()) != 1 {
		t.Fatalf("纯文本工具不该记：%v %d", err, len(drafts()))
	}
	if err := noteUnknown(ctx, db, tk.ID, workers.Run{Worker: "codex", Log: log}); err != nil || len(drafts()) != 2 {
		t.Fatalf("别的工具另记一条：%v %d", err, len(drafts()))
	}
	// 草稿满了：照常报上限错误，不静默吞掉。
	for len(must(ledger.List(ctx, db, ledger.Filter{Status: []ledger.Status{ledger.Draft}, Limit: 500}))) < org.MaxDrafts {
		must(ledger.Add(ctx, db, ledger.NewTask{Title: "占位", Org: dept.ID, Draft: true}, "u1"))
	}
	err = noteUnknown(ctx, db, tk.ID, workers.Run{Worker: "opencode", Log: log})
	if ae := (*api.Error)(nil); !errors.As(err, &ae) || ae.Code != "limit" {
		t.Fatalf("草稿满了应报错：%v", err)
	}
}

func TestPickDurationDisplayOnly(t *testing.T) {
	median, longest := int64(600000), int64(3000000)
	stat := workers.Stat{MedianMS: &median, MaxMS: &longest}
	v := Pick(PickInput{Risk: "low", Facts: []Fact{
		{ID: "slow", Stat: stat}, {ID: "fast"},
	}})
	if v.Recommended != "slow" || v.Candidates[0].Stat.Timing() != stat.Timing() {
		t.Fatalf("用时只展示，不改推荐：%+v", v)
	}
	text := dryText(RunResult{Task: ledger.Task{ID: "t1"}, Pick: &v})
	if !strings.Contains(text, "用时中位 10 分 · 最长 50 分") || !strings.Contains(text, "用时中位 — · 最长 —") {
		t.Fatal(text)
	}
}
