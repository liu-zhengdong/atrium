package workers

import (
	"context"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestParseWorker(t *testing.T) {
	cases := []struct {
		in   string
		want Spec
		bad  bool
	}{
		{in: "claude", want: Spec{Tool: "claude"}},
		{in: "claude:high", want: Spec{Tool: "claude", Effort: "high"}},
		{in: "claude+opus", want: Spec{Tool: "claude", Model: "opus"}},
		{in: "opencode+opencode-go/mimo-v2.6-flash:low", want: Spec{Tool: "opencode", Model: "opencode-go/mimo-v2.6-flash", Effort: "low"}},
		{in: "Claude", bad: true},
		{in: "claude+", bad: true},
		{in: "claude+a b", bad: true},
		{in: "claude+../x", bad: true},
		{in: "claude:HIGH", bad: true},
	}
	for _, c := range cases {
		got, err := ParseWorker(c.in)
		if (err != nil) != c.bad || (!c.bad && got != c.want) {
			t.Errorf("%q → %+v %v", c.in, got, err)
		}
		if !c.bad && got.String() != c.in {
			t.Errorf("%q 回写成 %q", c.in, got.String())
		}
	}
}

func TestBuild(t *testing.T) {
	dir := t.TempDir()
	pf := filepath.Join(dir, "p.md")
	in := func(model, effort string) Request {
		return Request{Prompt: "做事", PromptFile: pf, Dir: dir, Model: model, Effort: effort}
	}
	cases := []struct {
		tool string
		in   Request
		want []string // 必须按顺序出现的参数片段
		bad  string
	}{
		{tool: "claude", in: in("opus", "high"), want: []string{"-p", "--output-format", "stream-json", "--permission-mode", "bypassPermissions", "--model", "opus", "--effort", "high"}},
		{tool: "claude", in: Request{Prompt: "x", PromptFile: pf, Dir: dir, Live: true}, want: []string{"--input-format", "stream-json", "--replay-user-messages"}},
		{tool: "claude", in: Request{Prompt: "x", PromptFile: pf, Dir: dir, Session: "0123abcd-0123-0123-0123-0123456789ab"}, want: []string{"-p", "--resume", "0123abcd-0123-0123-0123-0123456789ab"}},
		{tool: "claude", in: in("", "ultra"), bad: "思考强度只能是"},
		{tool: "codex", in: in("gpt-6", "high"), want: []string{"exec", "--json", "-C", dir, "-m", "gpt-6", `model_reasoning_effort="high"`, "-"}},
		{tool: "codex", in: Request{Prompt: "x", PromptFile: pf, Dir: dir, Session: "0123abcd-0123-0123-0123-0123456789ab"}, want: []string{"exec", "resume", "--json", "0123abcd-0123-0123-0123-0123456789ab", "-"}},
		{tool: "opencode", in: in("p/m", "low"), want: []string{"run", "--format", "json", "--auto", "-m", "p/m", "--variant", "low", "--", "做事"}},
		{tool: "kimi", in: in("k2", ""), want: []string{"-p", "做事", "-m", "k2"}},
		{tool: "kimi", in: in("", "high"), bad: "不接受思考强度"},
		{tool: "grok", in: in("g", "low"), want: []string{"-p", "做事", "-m", "g", "--reasoning-effort", "low", "--always-approve", "--cwd", dir}},
		{tool: "agy", in: in("gemini-3.8-flash", "high"), want: []string{"--print=做事", "--model", "gemini-3.8-flash", "--effort", "high"}},
		{tool: "agy", in: in("claude-opus", "high"), bad: "不接受思考强度"},
		{tool: "cursor", in: in("gpt-5.3-codex-fast", "high"), want: []string{"-p", "--workspace", dir, "--model", "gpt-5.3-codex-high-fast"}},
		{tool: "cursor", in: in("auto", "high"), bad: "auto"},
		{tool: "claude", in: Request{Prompt: "x", PromptFile: pf, Dir: "rel"}, bad: "绝对路径"},
		{tool: "kimi", in: Request{Prompt: "x", PromptFile: pf, Dir: dir, Live: true}, bad: "不能即时送捎话"},
	}
	for _, c := range cases {
		a, _ := Builtin(c.tool)
		l, err := a.Build(c.in)
		if c.bad != "" {
			if err == nil || !strings.Contains(err.Error(), c.bad) {
				t.Errorf("%s %+v：应报 %q，得到 %v", c.tool, c.in, c.bad, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s：%v", c.tool, err)
			continue
		}
		if !inOrder(l.Args, c.want) {
			t.Errorf("%s 参数 %q 里没有按序出现 %q", c.tool, l.Args, c.want)
		}
		if l.Dir != c.in.Dir || l.Exe != a.Exe {
			t.Errorf("%s：%+v", c.tool, l)
		}
	}
	// 走标准输入的接提示词文件，走参数的不接。
	for tool, stdin := range map[string]bool{"claude": true, "codex": true, "cursor": true, "opencode": false, "kimi": false} {
		a, _ := Builtin(tool)
		l, _ := a.Build(in("", ""))
		if (l.StdinFile == pf) != stdin {
			t.Errorf("%s StdinFile=%q", tool, l.StdinFile)
		}
	}
	// 端点：codex 只接 responses；claude 设 ANTHROPIC_BASE_URL。
	a, _ := Builtin("codex")
	if _, err := a.Build(Request{Prompt: "x", PromptFile: pf, Dir: dir, Endpoint: &Endpoint{BaseURL: "https://x", API: "openai"}}); err == nil {
		t.Error("codex 不接 openai 端点")
	}
	a, _ = Builtin("claude")
	l, _ := a.Build(Request{Prompt: "x", PromptFile: pf, Dir: dir, Endpoint: &Endpoint{BaseURL: "https://gw", API: "anthropic", KeyEnv: "ANTHROPIC_AUTH_TOKEN"}})
	if l.Env["ANTHROPIC_BASE_URL"] != "https://gw" {
		t.Errorf("claude 端点：%+v", l.Env)
	}
}

func inOrder(args, want []string) bool {
	i := 0
	for _, a := range args {
		if i < len(want) && a == want[i] {
			i++
		}
	}
	return i == len(want)
}

func TestCLISpec(t *testing.T) {
	ok := CLISpec{Command: "mytool", Args: []string{"run", "{model_args}", "--cwd", "{cwd}", "{prompt}"}, ModelArgs: []string{"-m", "{model}"},
		DoneMatch: "^DONE$", Env: map[string]string{"MY_MODEL": "{model}"}}
	if p := ok.Problems("mytool"); len(p) > 0 {
		t.Fatalf("应能用：%v", p)
	}
	bad := []struct {
		name string
		s    CLISpec
		want string
	}{
		{"claude", CLISpec{Command: "x"}, "内置工具"},
		{"t", CLISpec{Command: "/bin/x"}, "只写 PATH 上的命令名"},
		{"t", CLISpec{Command: "x", Args: []string{"{what}"}}, "不是占位"},
		{"t", CLISpec{Command: "x", Args: []string{"-a{model_args}"}}, "单独占一项"},
		{"t", CLISpec{Command: "x", ModelArgs: []string{"-m"}}, "没有 {model_args}"},
		{"t", CLISpec{Command: "x", Args: []string{"{effort}"}}, "没写 efforts"},
		{"t", CLISpec{Command: "x", Args: []string{"{prompt}", "{prompt_file}"}}, "只用一个"},
		{"t", CLISpec{Command: "x", DoneMatch: "("}, "不是合法正则"},
		{"t", CLISpec{Command: "x", Env: map[string]string{"ATRIUM_X": "1"}}, "不能盖"},
	}
	for _, c := range bad {
		p := strings.Join(c.s.Problems(c.name), "；")
		if !strings.Contains(p, c.want) {
			t.Errorf("%+v：应报 %q，得到 %q", c.s, c.want, p)
		}
	}
	a := cliAdapter("mytool", ok)
	dir := t.TempDir()
	l, err := a.Build(Request{Prompt: "hi", PromptFile: filepath.Join(dir, "p"), Dir: dir})
	if err != nil || !reflect.DeepEqual(l.Args, []string{"run", "--cwd", dir, "hi"}) || l.StdinFile != "" || l.Env != nil {
		t.Fatalf("没模型整组省掉：%+v %v", l, err)
	}
	l, _ = a.Build(Request{Prompt: "hi", PromptFile: filepath.Join(dir, "p"), Dir: dir, Model: "m1"})
	if !reflect.DeepEqual(l.Args, []string{"run", "-m", "m1", "--cwd", dir, "hi"}) || l.Env["MY_MODEL"] != "m1" {
		t.Fatalf("有模型：%+v", l)
	}
	stdin := cliAdapter("s", CLISpec{Command: "s", Args: []string{"go"}})
	l, _ = stdin.Build(Request{Prompt: "hi", PromptFile: filepath.Join(dir, "p"), Dir: dir})
	if l.StdinFile == "" {
		t.Fatal("没有 {prompt} 时提示词走标准输入")
	}
	if e := a.Ended("working\nDONE\n"); !e.Known || !e.OK {
		t.Fatalf("done_match 命中：%+v", e)
	}
	if e := a.Ended("working\n"); !e.Known || e.OK {
		t.Fatalf("done_match 没命中：%+v", e)
	}
}

func TestProfileEdit(t *testing.T) {
	src := "---\ntrust: medium\nchecks: [pr_exists]\n---\n先跑相关测试。\n"
	out, err := ApplyEdit("combos/claude+opus", "", Edit{Source: &src})
	if err != nil || !strings.Contains(out, "先跑相关测试。") {
		t.Fatalf("%q %v", out, err)
	}
	out, err = ApplyEdit("combos/claude+opus", out, Edit{Set: map[string]string{"max_risk": "high", "checks": "[]"}, Unset: []string{"trust"}})
	if err != nil {
		t.Fatal(err)
	}
	keys, body, _ := SplitSource(out)
	if keys["max_risk"] != "high" || keys["trust"] != nil || body != "先跑相关测试。" {
		t.Fatalf("%v %q", keys, body)
	}
	r, _ := decodeRules(keys)
	if r.Checks == nil || len(r.Checks) != 0 {
		t.Fatalf("checks: [] 表示不加查（非 nil 的空）：%#v", r.Checks)
	}
	bad := []struct {
		name string
		e    Edit
		want string
	}{
		{"harness/claude", Edit{Set: map[string]string{"trust": "super"}}, "trust 只能是"},
		{"harness/claude", Edit{Set: map[string]string{"colour": "red"}}, "规则写得不对"},
		{"models/opus", Edit{Set: map[string]string{"protocol": "cli", "command": "x"}}, "只能写在 harness 层"},
		{"harness/nope", Edit{Set: map[string]string{"trust": "low"}}, "不是内置工具"},
		{"harness/claude", Edit{Set: map[string]string{"endpoint": "ftp://x", "endpoint_api": "openai"}}, "http(s)"},
		{"combos/claude", Edit{Set: map[string]string{"trust": "low"}}, "只有 combos 层"},
		{"skills/x", Edit{Set: map[string]string{"trust": "low"}}, "档案名应为"},
		{"harness/claude", Edit{Unset: []string{"trust"}}, "没有 trust"},
	}
	for _, c := range bad {
		if _, err := ApplyEdit(c.name, "", c.e); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s %+v：应报 %q，得到 %v", c.name, c.e, c.want, err)
		}
	}
}

func TestResolveAndRefusal(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	must := func(name, src string) {
		t.Helper()
		if _, err := SaveProfile(ctx, db, name, Edit{Source: &src}, "u1"); err != nil {
			t.Fatal(err)
		}
	}
	must("harness/claude", "---\ntrust: low\nchecks: [finished]\nmodel: sonnet\n---\n工具层叮嘱")
	must("models/opus", "---\ntrust: medium\n---\n模型层叮嘱")
	must("combos/claude+opus", "---\nmax_risk: high\nmodel: claude-opus-5\n---\n组合层叮嘱")
	must("harness/mytool", "---\nprotocol: cli\ncommand: mytool\nargs: [\"{prompt}\"]\n---\n")

	r, err := Resolve(ctx, db, "claude+opus:high")
	if err != nil {
		t.Fatal(err)
	}
	if r.ID != "claude+opus:high" || r.CLIModel != "claude-opus-5" || r.Rules.Trust != "medium" || r.Rules.MaxRisk != "high" ||
		!reflect.DeepEqual(r.Rules.Checks, []string{"finished"}) || r.Body != "工具层叮嘱\n\n模型层叮嘱\n\n组合层叮嘱" ||
		!reflect.DeepEqual(r.Layers, []string{"harness/claude", "models/opus", "combos/claude+opus"}) {
		t.Fatalf("叠加：%+v", r)
	}
	// 只写工具：模型取 harness 的 model。
	r, _ = Resolve(ctx, db, "claude")
	if r.ID != "claude+sonnet" || r.Rules.EffectiveMaxRisk() != "low" {
		t.Fatalf("只写工具：%+v", r)
	}
	if r.Rules.Refusal("medium") == "" || r.Rules.Refusal("low") != "" {
		t.Fatal("trust=low 只接 low")
	}
	if r, err := Resolve(ctx, db, "mytool"); err != nil || r.Adapter.Exe != "mytool" {
		t.Fatalf("通用命令行执行者：%+v %v", r, err)
	}
	if _, err := Resolve(ctx, db, "nosuch"); err == nil {
		t.Fatal("未知工具应拒绝")
	}
	ids, _ := Catalog(ctx, db)
	if ids[0] != "claude+opus" || ids[len(ids)-1] != "mytool" {
		t.Fatalf("目录：%v", ids)
	}
	rows, err := List(ctx, db)
	if err != nil || rows[0].ID != "claude+opus" || rows[0].Trust != "medium" {
		t.Fatalf("列表：%+v %v", rows, err)
	}
}

func TestClassify(t *testing.T) {
	now := time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)
	cases := []struct {
		name  string
		code  int
		tail  string
		kind  string
		reset time.Time
	}{
		{"codex 额度", 1, "working\nERROR: You've hit your usage limit. Try again in ~90 min.\n", SignalQuota, now.Add(90 * time.Minute)},
		{"codex --json 额度", 1, `{"type":"turn.started"}` + "\n" + `{"type":"turn.failed","error":{"message":"You've hit your usage limit. Try again in ~5 min."}}`, SignalQuota, now.Add(5 * time.Minute)},
		{"claude 额度", 1, `{"type":"result","is_error":true,"result":"Claude AI usage limit reached|resets 3pm (UTC)"}`, SignalQuota, time.Date(2026, 9, 29, 15, 0, 0, 0, time.UTC)},
		{"429", 1, "Error: HTTP/1.1 429 Too Many Requests\nretry-after: 30\n", SignalQuota, now.Add(30 * time.Second)},
		{"正文提到额度不算", 1, `{"type":"assistant","message":{"content":[{"type":"text","text":"usage limit reached"}]}}`, SignalNone, time.Time{}},
		{"退出码 0 不判额度", 0, "Error: usage limit reached\n", SignalNone, time.Time{}},
		{"网络", 1, "Error: fetch failed\n", SignalTransient, time.Time{}},
		{"过载事件", 1, `{"type":"error","error":{"name":"APIError","data":{"message":"Overloaded"}}}`, SignalTransient, time.Time{}},
		{"5xx", 1, "error: status 503 Service Unavailable\n", SignalTransient, time.Time{}},
		{"grok 没登录", 1, "Not signed in\n", SignalLogin, time.Time{}},
		{"claude 没登录", 1, `{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}`, SignalLogin, time.Time{}},
		{"退出码 0 不判没登录", 0, "Not signed in\n", SignalNone, time.Time{}},
		// t330 现场 agy 里 Claude 模型撞额度的原文（#543）
		{"agy Claude 模型额度", 1, "API error (attempt 5): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h57m45s\n", SignalQuota, now.Add(2*time.Hour + 57*time.Minute + 45*time.Second)},
		{"agy 结果事件里的额度", 1, `{"event":"result","result":{"status":"ERROR","error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 12m"}}`, SignalQuota, now.Add(12 * time.Minute)},
		// t342 现场 agy 不认不带强度的模型名的原文（#563）
		{"agy 模型名无效", 1, `invalid model selection (--model "gemini-3.8-flash" --effort "")` + "\n", SignalModel, time.Time{}},
		{"claude 模型不存在", 1, `{"type":"result","is_error":true,"result":"There's an issue with the selected model (claude-nope). It may not exist or you may not have access to it."}`, SignalModel, time.Time{}},
		{"codex 模型不支持", 1, "ERROR: The 'gpt-nope' model is not supported when using Codex with a ChatGPT account.\n", SignalModel, time.Time{}},
		{"退出码 0 不判模型名", 0, "invalid model selection\n", SignalNone, time.Time{}},
		{"接管不判临时错误", ExitUnknown, "Error: fetch failed\n", SignalNone, time.Time{}},
		{"之后正常收尾", 1, "Error: fetch failed\n" + `{"type":"result","is_error":false,"stop_reason":"end_turn"}`, SignalNone, time.Time{}},
		{"思考耗尽", 0, `{"type":"step_finish","part":{"reason":"length","tokens":{"reasoning":32000,"output":0}}}`, SignalThinking, time.Time{}},
		{"长度用尽但有正文", 0, `{"type":"step_finish","part":{"reason":"length","tokens":{"reasoning":100,"output":900}}}`, SignalNone, time.Time{}},
	}
	for _, c := range cases {
		s := Classify(c.code, c.tail, now)
		if s.Kind != c.kind {
			t.Errorf("%s：得到 %+v", c.name, s)
		}
		if !c.reset.IsZero() && s.ResetAt != c.reset.UnixMilli() {
			t.Errorf("%s：恢复时刻 %v，应为 %v", c.name, time.UnixMilli(s.ResetAt).UTC(), c.reset)
		}
	}
}

func TestEnded(t *testing.T) {
	claude, _ := Builtin("claude")
	agy, _ := Builtin("agy")
	codex, _ := Builtin("codex")
	cases := []struct {
		a     *Driver
		tail  string
		known bool
		ok    bool
	}{
		{claude, `{"type":"result","is_error":false,"result":"done"}`, true, true},
		{claude, `{"type":"result","is_error":true,"subtype":"error_max_turns"}`, true, false},
		{claude, `{"type":"assistant"}`, false, false},
		{agy, `{"event":"result","result":{"status":"ERROR","error":"boom"}}`, true, false},
		{codex, "anything", false, false},
		{codex, `{"type":"item.completed","item":{"type":"agent_message","text":"好了"}}` + "\n" + `{"type":"turn.completed","usage":{}}`, true, true},
		{codex, `{"type":"turn.failed","error":{"message":"boom"}}`, true, false},
	}
	for _, c := range cases {
		e := c.a.Ended(c.tail)
		if e.Known != c.known || e.OK != c.ok {
			t.Errorf("%s %q → %+v", c.a.Tool, c.tail, e)
		}
	}
	if s := claude.SessionOf(`{"type":"system","subtype":"init","cwd":"/x","session_id":"0123abcd-0123-0123-0123-0123456789ab"}`); s != "0123abcd-0123-0123-0123-0123456789ab" {
		t.Errorf("会话 id：%q", s)
	}
	if s := codex.SessionOf(`{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}`); s != "0199a213-81c0-7800-8aa1-bbab2a035a53" {
		t.Errorf("codex 会话 id：%q", s)
	}
	if r := codex.LastReply(`{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"审阅结论：通过"}}` + "\n" + `{"type":"turn.completed"}`); r != "审阅结论：通过" {
		t.Errorf("codex 最后回复：%q", r)
	}
}

func TestMarkOf(t *testing.T) {
	now := time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)
	agy := Spec{Tool: "agy", Model: "claude-opus-4-6-thinking", Effort: "high"}
	reset := now.Add(3 * time.Hour).UnixMilli()
	cases := []struct {
		name   string
		sig    Signal
		ok     bool
		target string
		until  int64
	}{
		{"额度用尽按报文恢复", Signal{Kind: SignalQuota, ResetAt: reset}, true, "agy+claude-opus-4-6-thinking@h3", reset},
		{"额度用尽读不出恢复时刻", Signal{Kind: SignalQuota}, true, "agy+claude-opus-4-6-thinking@h3", now.Add(QuotaHold).UnixMilli()},
		{"没登录标整个工具、等人处理", Signal{Kind: SignalLogin}, true, "agy@h3", 0},
		{"模型名无效等人处理", Signal{Kind: SignalModel}, true, "agy+claude-opus-4-6-thinking@h3", 0},
		{"临时错误不标", Signal{Kind: SignalTransient}, false, "", 0},
		{"思考耗尽不标", Signal{Kind: SignalThinking}, false, "", 0},
	}
	for _, c := range cases {
		m, ok := MarkOf(c.sig, agy, "h3", now)
		if ok != c.ok || (ok && (m.Target() != c.target || m.Until != c.until || m.Reason == "")) {
			t.Errorf("%s：%v %+v", c.name, ok, m)
		}
	}
}

func TestBlocked(t *testing.T) {
	marks := []Mark{
		{Tool: "agy", Model: "claude-opus-4-6-thinking", Host: "h1", Reason: "额度用尽"},
		{Tool: "grok", Host: "h3", Reason: "没登录"},
	}
	cases := []struct {
		name, tool, model, host string
		want                    bool
	}{
		{"同一组合同一台", "agy", "claude-opus-4-6-thinking", "h1", true},
		{"同一工具别的模型不受影响", "agy", "gemini-3.8-flash-high", "h1", false},
		{"别的机器不受影响", "agy", "claude-opus-4-6-thinking", "h3", false},
		{"没写模型的挡这个工具的全部模型", "grok", "grok-4.6", "h3", true},
		{"没写模型的只挡那台", "grok", "grok-4.6", "h1", false},
	}
	for _, c := range cases {
		if _, got := Blocked(marks, c.tool, c.model, c.host); got != c.want {
			t.Errorf("%s：%v", c.name, got)
		}
	}
}

func TestMarksStore(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now()
	for _, m := range []Mark{
		{Tool: "agy", Model: "claude-opus-4-6-thinking", Host: "h1", Kind: SignalQuota, Reason: "额度用尽", Until: now.Add(time.Hour).UnixMilli()},
		{Tool: "agy", Model: "old", Host: "h1", Kind: SignalQuota, Reason: "额度用尽", Until: now.Add(-time.Minute).UnixMilli()},
		{Tool: "agy", Model: "gemini-x", Host: "h3", Kind: SignalModel, Reason: "模型名无效"},
		{Tool: "grok", Host: "h3", Kind: SignalLogin, Reason: "没登录"},
	} {
		m.Since = now.UnixMilli()
		if err := SetMark(ctx, db, m); err != nil {
			t.Fatal(err)
		}
	}
	got, err := Marks(ctx, db, now.UnixMilli())
	if err != nil || len(got) != 3 {
		t.Fatalf("到期的不算：%+v %v", got, err)
	}
	if _, err := ClearMarks(ctx, db, "agy+bad model"); err == nil || !strings.HasPrefix(err.Error(), "--clear:") {
		t.Errorf("写错的应以参数名开头报错：%v", err)
	}
	for _, c := range []struct {
		target string
		n      int64
	}{{"grok@h1", 0}, {"agy+claude-opus-4-6-thinking:high@h1", 1}, {"agy", 1}, {"grok@h3", 1}, {"grok", 0}} {
		if n, err := ClearMarks(ctx, db, c.target); err != nil || n != c.n {
			t.Errorf("解除 %s：%d %v", c.target, n, err)
		}
	}
	if got, _ := Marks(ctx, db, now.UnixMilli()); len(got) != 0 {
		t.Errorf("应全部解除：%+v", got)
	}
}
