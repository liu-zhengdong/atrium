package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/platform"
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
		{tool: "claude", in: in("opus", "high"), want: []string{"-p", "--output-format", "stream-json", "--permission-mode", "bypassPermissions", "--setting-sources", "user,project", "--strict-mcp-config", "--model", "opus", "--effort", "high"}},
		{tool: "claude", in: Request{Prompt: "x", PromptFile: pf, Dir: dir, Live: true}, want: []string{"--input-format", "stream-json", "--replay-user-messages"}},
		{tool: "claude", in: Request{Prompt: "x", PromptFile: pf, Dir: dir, Session: "0123abcd-0123-0123-0123-0123456789ab"}, want: []string{"-p", "--resume", "0123abcd-0123-0123-0123-0123456789ab"}},
		{tool: "claude", in: in("", "ultra"), bad: "思考强度只能是"},
		{tool: "codex", in: in("gpt-6", "high"), want: []string{"exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--dangerously-bypass-approvals-and-sandbox", "-C", dir, "--disable", "apps", "-m", "gpt-6", `model_reasoning_effort="high"`, "-"}},
		{tool: "codex", in: Request{Prompt: "x", PromptFile: pf, Dir: dir, Session: "0123abcd-0123-0123-0123-0123456789ab"}, want: []string{"exec", "resume", "--json", "--skip-git-repo-check", "--ignore-user-config", "--dangerously-bypass-approvals-and-sandbox", "--disable", "apps", "0123abcd-0123-0123-0123-0123456789ab", "-"}},
		{tool: "codex", in: Request{Prompt: "x", PromptFile: pf, Dir: dir, ComputerUse: []string{`mcp_servers={computer-use={command="cu"}}`}}, want: []string{"--ignore-user-config", "-C", dir, "-c", "-"}},
		{tool: "opencode", in: in("p/m", "low"), want: []string{"run", "--format", "json", "--auto", "-m", "p/m", "--variant", "low"}},
		{tool: "kimi", in: in("k2", ""), want: []string{"-p", "请先完整读取任务说明文件 " + pf + "，然后按文件内容执行。", "-m", "k2"}},
		{tool: "kimi", in: in("", "high"), bad: "不接受思考强度"},
		{tool: "grok", in: in("g", "low"), want: []string{"--prompt-file", pf, "--output-format", "streaming-messages-json", "-m", "g", "--reasoning-effort", "low", "--always-approve", "--cwd", dir}},
		{tool: "pi", in: in("opencode-go/glm-5.3-flash", "high"), want: []string{"-p", "--mode", "json", "-na", "--model", "opencode-go/glm-5.3-flash", "--thinking", "high"}},
		{tool: "pi", in: in("opencode-go/glm-5.3-flash", ""), want: []string{"--model", "opencode-go/glm-5.3-flash"}},
		{tool: "pi", in: in("opencode-go/glm-5.3-flash", ""), want: []string{"--session-dir", filepath.Join(dir, "pi-sessions")}},
		{tool: "pi", in: Request{Prompt: "x", PromptFile: pf, Dir: dir, Session: "0123abcd-0123-0123-0123-0123456789ab"}, want: []string{"-p", "--mode", "json", "-na", "--session-id", "0123abcd-0123-0123-0123-0123456789ab"}},
		{tool: "pi", in: in("", "high"), bad: "要指定模型才能给思考强度"},
		{tool: "agy", in: in("gemini-3.8-flash", "high"), want: []string{"--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-3.8-flash", "--effort", "high"}},
		{tool: "agy", in: in("claude-opus", "high"), bad: "不接受思考强度"},
		{tool: "cursor", in: in("gpt-5.3-codex-fast", "high"), want: []string{"-p", "--workspace", dir, "--model", "gpt-5.3-codex-high-fast"}},
		{tool: "cursor", in: in("auto", "high"), bad: "auto"},
		{tool: "claude", in: Request{Prompt: "x", PromptFile: pf, Dir: "rel"}, bad: "绝对路径"},
		{tool: "kimi", in: Request{Prompt: "x", PromptFile: pf, Dir: dir, Live: true}, bad: "不能即时送补充说明"},
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
	// 没写模型：codex、grok 不传模型参数，跟随工具自带的缺省。
	for _, tool := range []string{"codex", "grok"} {
		a, _ := Builtin(tool)
		l, err := a.Build(in("", ""))
		if err != nil || slices.Contains(l.Args, "-m") {
			t.Errorf("%s 没写模型不应传 -m：%q %v", tool, l.Args, err)
		}
	}
	// 走标准输入的接提示词文件，走文件路径的只传路径。
	for tool, stdin := range map[string]bool{"claude": true, "codex": true, "cursor": true, "opencode": true, "kimi": false, "grok": false, "agy": false} {
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

func TestWindowsBatchLongPrompt(t *testing.T) {
	dir := t.TempDir()
	for _, prompt := range []string{"第一行\n第二行", strings.Repeat("长说明", 10000)} {
		for _, tool := range []string{"opencode", "agy", "kimi", "grok"} {
			req := Request{Dir: dir, PromptFile: filepath.Join(dir, "prompt.md"), Prompt: prompt}
			l, err := Build(tool, req)
			if err != nil {
				t.Fatalf("%s Build: %v", tool, err)
			}
			line, err := platform.BatchCommandLine("", `C:\\bin\\`+tool+`.cmd`, l.Args)
			if err != nil || strings.Contains(line, prompt) || len(line) >= 8191 {
				t.Fatalf("%s Windows 命令行含说明或过长: len=%d err=%v", tool, len(line), err)
			}
			if tool == "opencode" && l.StdinFile != req.PromptFile {
				t.Fatal("opencode 未接提示词文件到 stdin")
			}
			if tool == "agy" {
				var event struct {
					Event   string `json:"event"`
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
				}
				if err := json.Unmarshal([]byte(l.StdinData), &event); err != nil || event.Event != "user" || event.Message.Content != prompt {
					t.Fatalf("agy stdin 未保留原文: %v", err)
				}
			}
		}
	}
	if _, err := platform.BatchCommandLine("", `C:\\bin\\opencode.cmd`, []string{"run", "第一行\n第二行"}); err == nil {
		t.Fatal("BatchCommandLine 应继续拒绝换行参数")
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
	if e := a.Ended("working\r\nDONE\r\n"); !e.Known || !e.OK {
		t.Fatalf("Windows 原生工具的 CRLF 行尾不算进行里：%+v", e)
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
		{"harness/claude", Edit{Set: map[string]string{"limits": "{max_tasks: 1}"}}, "field limits not found"},
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
	detail, err := Show(ctx, db, "claude+opus:high")
	if err != nil || len(detail.Layers) != 3 {
		t.Fatalf("Show 各层原文：%+v %v", detail, err)
	}
	for i, name := range r.Layers {
		p, err := GetProfile(ctx, db, name)
		if err != nil || !reflect.DeepEqual(detail.Layers[i], *p) {
			t.Fatalf("第 %d 层原文不一致：%v", i, err)
		}
	}
	// 档案写的模型与标识里的只差 provider 前缀：两种写法是同一个执行者，ID 按档案写的，目录里只一行。
	must("combos/opencode+deepseek-v4.1-flash", "---\nmodel: opencode-go/deepseek-v4.1-flash\n---\n")
	for _, id := range []string{"opencode+deepseek-v4.1-flash", "opencode+opencode-go/deepseek-v4.1-flash:high"} {
		r, err := Resolve(ctx, db, id)
		if err != nil || r.Spec.Model != "opencode-go/deepseek-v4.1-flash" || r.CLIModel != r.Spec.Model {
			t.Errorf("%s：%+v %v", id, r, err)
		}
	}
	if ids, _ := List(ctx, db); slices.ContainsFunc(ids, func(r Row) bool { return r.ID == "opencode+deepseek-v4.1-flash" }) {
		t.Errorf("目录里还有不带前缀的那行：%+v", ids)
	}
	// 只写工具：模型取 harness 的 model。
	r, _ = Resolve(ctx, db, "claude")
	if r.ID != "claude+sonnet" || r.Rules.EffectiveMaxRisk() != "low" {
		t.Fatalf("只写工具：%+v", r)
	}
	if r.Rules.Refusal("medium", true) == "" || r.Rules.Refusal("low", true) != "" {
		t.Fatal("trust=low 只接 low")
	}
	// 只写工具、档案没写 model：有别名缺省的补上（claude 的 opus 在上面被 harness 盖掉，这里看 cursor 的 auto），
	// 没有的不传模型、ID 只有工具名，models/ 档案挂不上。
	for id, want := range map[string]string{"cursor": "cursor+auto", "codex:high": "codex:high", "grok": "grok"} {
		r, err := Resolve(ctx, db, id)
		if err != nil || r.ID != want || (want != "cursor+auto" && (r.CLIModel != "" || r.Spec.Model != "")) {
			t.Errorf("%s：%+v %v", id, r, err)
		}
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
		{"正文提到额度不算", 1, `{"type":"assistant","message":{"content":[{"type":"text","text":"usage limit reached"}]}}`, SignalTransient, time.Time{}},
		{"退出码 0 不判额度", 0, "Error: usage limit reached\n", SignalNone, time.Time{}},
		// 认不出的出错退出不按措辞分：数不出步骤（通用命令行）或做过事的都按临时错误重试
		{"网络", 1, "Error: fetch failed\n", SignalTransient, time.Time{}},
		{"过载事件", 1, `{"type":"error","error":{"name":"APIError","data":{"message":"Overloaded"}}}`, SignalTransient, time.Time{}},
		{"容量不足", 1, `{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}`, SignalTransient, time.Time{}},
		{"grok 没登录", 1, "Not signed in\n", SignalSetup, time.Time{}},
		{"claude 没登录", 1, `{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}`, SignalSetup, time.Time{}},
		// t415 现场 h3 上 kimi 没登录的原文：报错之后还跟着一行 libuv 崩溃，退出码是 Windows 的 0xC0000409
		{"kimi 没登录", 3221226505, "error: failed to run prompt: auth.login_required: OAuth provider \"managed:kimi-code\" requires login before it can be used.\nSee log: C:/Users/CPCli/.kimi-code/logs/kimi-code.log\nAssertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76\n", SignalSetup, time.Time{}},
		{"退出码 0 不判没登录", 0, "Not signed in\n", SignalNone, time.Time{}},
		// t392 现场 h3 上 codex 的 Node 版本管理器没选版本的原文
		{"Node 没选版本", 1, "No active Node.js version is configured\n", SignalSetup, time.Time{}},
		{"zsh 找不到命令", 127, "zsh: command not found: codex\n", SignalSetup, time.Time{}},
		{"bash 找不到命令", 127, "bash: line 1: codex: command not found\n", SignalSetup, time.Time{}},
		{"dash 找不到命令", 127, "/bin/sh: 1: codex: not found\n", SignalSetup, time.Time{}},
		{"shebang 找不到 node", 127, "env: node: No such file or directory\n", SignalSetup, time.Time{}},
		{"Windows 找不到命令", 1, "'codex' 不是内部或外部命令，也不是可运行的程序\n或批处理文件。\n", SignalSetup, time.Time{}},
		{"Windows 英文找不到命令", 1, "'codex' is not recognized as an internal or external command,\noperable program or batch file.\n", SignalSetup, time.Time{}},
		{"拉起子进程 ENOENT", 1, "Error: spawn codex ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:285:19)\n", SignalSetup, time.Time{}},
		{"Go 找不到可执行文件", 1, `exec: "codex": executable file not found in $PATH` + "\n", SignalSetup, time.Time{}},
		{"退出码 0 不判缺运行环境", 0, "zsh: command not found: rg\n", SignalNone, time.Time{}},
		{"读不到文件不算缺运行环境", 1, "Error: ENOENT: no such file or directory, open 'a.txt'\n", SignalTransient, time.Time{}},
		// t330 现场 agy 里 Claude 模型撞额度的原文（#543）
		{"agy Claude 模型额度", 1, "API error (attempt 5): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h57m45s\n", SignalQuota, now.Add(2*time.Hour + 57*time.Minute + 45*time.Second)},
		// t349、t352 现场 agy+gemini-3.8-flash-high 的收尾：没有 RESOURCE_EXHAUSTED、没有恢复时刻
		{"agy Individual quota reached", 1, `{"event":"result","result":{"status":"ERROR","error":"Individual quota reached"}}`, SignalQuota, time.Time{}},
		{"纯文本 quota reached", 1, "Individual quota reached\n", SignalQuota, time.Time{}},
		{"quota 在后", 1, "Error: You exceeded your current quota, please check your plan\n", SignalQuota, time.Time{}},
		{"下划线连写", 1, `{"type":"error","error":{"code":"quota_exceeded"}}`, SignalQuota, time.Time{}},
		{"限定词 limit 在前", 1, "Error: Rate limit hit\n", SignalQuota, time.Time{}},
		{"上下文 limit 不算额度", 1, "Error: context limit reached\n", SignalTransient, time.Time{}},
		{"单词里的 hit 不算", 1, "Error: whitelist quota config missing\n", SignalTransient, time.Time{}},
		{"agy 结果事件里的额度", 1, `{"event":"result","result":{"status":"ERROR","error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 12m"}}`, SignalQuota, now.Add(12 * time.Minute)},
		// t342 现场 agy 不认不带强度的模型名的原文（#563）
		{"agy 模型名无效", 1, `invalid model selection (--model "gemini-3.8-flash" --effort "")` + "\n", SignalModel, time.Time{}},
		{"claude 模型不存在", 1, `{"type":"result","is_error":true,"result":"There's an issue with the selected model (claude-nope). It may not exist or you may not have access to it."}`, SignalModel, time.Time{}},
		{"codex 模型不支持", 1, "ERROR: The 'gpt-nope' model is not supported when using Codex with a ChatGPT account.\n", SignalModel, time.Time{}},
		{"退出码 0 不判模型名", 0, "invalid model selection\n", SignalNone, time.Time{}},
		{"继续跟进、没有报错收尾不判", ExitUnknown, "Error: fetch failed\n", SignalNone, time.Time{}},
		{"继续跟进、报错收尾照判", ExitUnknown, `{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}`, SignalTransient, time.Time{}},
		{"继续跟进、报错收尾是额度", ExitUnknown, `{"type":"turn.failed","error":{"message":"You've hit your usage limit. Try again in ~5 min."}}`, SignalQuota, now.Add(5 * time.Minute)},
		{"之后正常收尾", 1, "Error: fetch failed\n" + `{"type":"result","is_error":false,"stop_reason":"end_turn"}`, SignalNone, time.Time{}},
		{"思考耗尽", 0, `{"type":"step_finish","part":{"reason":"length","tokens":{"reasoning":32000,"output":0}}}`, SignalThinking, time.Time{}},
		{"长度用尽但有正文", 0, `{"type":"step_finish","part":{"reason":"length","tokens":{"reasoning":100,"output":900}}}`, SignalNone, time.Time{}},
	}
	for _, c := range cases {
		s := Classify(c.code, "", LogTail{Text: c.tail}, now)
		if s.Kind != c.kind {
			t.Errorf("%s：得到 %+v", c.name, s)
		}
		if c.kind == SignalSetup {
			want := "缺运行环境"
			if strings.Contains(c.name, "没登录") {
				want = "没登录"
			}
			if s.Reason != want || s.Evidence == "" || strings.Contains(s.Evidence, "\n") || !strings.Contains(c.tail, s.Evidence) {
				t.Errorf("%s：原因应为 %s、证据应是报文里的一行，得到 %+v", c.name, want, s)
			}
		}
		if !c.reset.IsZero() && s.ResetAt != c.reset.UnixMilli() {
			t.Errorf("%s：恢复时刻 %v，应为 %v", c.name, time.UnixMilli(s.ResetAt).UTC(), c.reset)
		}
	}
}

// 报文认不出的出错退出按行为判：一步没做的算零步骤出错退出，做过事的不算。样本是现场日志尾巴的写法。
func TestClassifyNoStart(t *testing.T) {
	now := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	read := func(f string) string {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	// t497、t535 现场：opencode 交给工具的模型名少了 opencode-go/ 前缀，1～2 秒退出码 1，日志只有这一行
	unknown := `{"type":"error","timestamp":1790730960000,"sessionID":"ses_2f1c9a7e0ffeYk3QpLx8Rm1Vb","error":{"name":"UnknownError","data":{"message":"Unexpected server error"}}}` + "\n"
	cases := []struct {
		name, worker string
		code         int
		tail, kind   string
		cut          bool
	}{
		{"opencode UnknownError 零步骤", "opencode+deepseek-v4.1-flash", 1, unknown, SignalNoStart, false},
		// t392 codex+gpt-6-sol 在 h3、h1 各一次退出码 1：原日志没拿到，按 codex 的事件写成开了线程、一步没做
		{"codex 零步骤退出码 1", "codex+gpt-6-sol", 1, `{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}` + "\n" + `{"type":"turn.started"}` + "\n", SignalNoStart, false},
		{"日志是空的", "codex+gpt-6-sol", 1, "", SignalNoStart, false},
		{"干了活之后退出码 1 按临时错误重试", "opencode+deepseek-v4.1-flash", 1, read("testdata/opencode-sample.jsonl") + unknown, SignalTransient, false},
		{"agy 做了 23 步后退出码 1 按临时错误重试", "agy+gemini-3.8-flash-high", 1, read("testdata/agy-t349.jsonl"), SignalTransient, false},
		{"退出码 0 不判", "opencode+deepseek-v4.1-flash", 0, unknown, SignalNone, false},
		{"继续跟进拿不到退出码不判", "opencode+deepseek-v4.1-flash", ExitUnknown, unknown, SignalNone, false},
		{"通用命令行数不出步骤，按临时错误重试", "mycli", 1, "boom\n", SignalTransient, false},
		{"日志比尾巴长、尾巴里数不出步骤，按临时错误重试", "opencode+deepseek-v4.1-flash", 1, unknown, SignalTransient, true},
		{"认得出的原因照原因判", "opencode+deepseek-v4.1-flash", 1, `{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}`, SignalSetup, false},
	}
	for _, c := range cases {
		s := Classify(c.code, c.worker, LogTail{Text: c.tail, Cut: c.cut}, now)
		if s.Kind != c.kind {
			t.Errorf("%s：得到 %+v", c.name, s)
		}
	}
	if s := Classify(1, "opencode+deepseek-v4.1-flash", LogTail{Text: unknown}, now); !strings.Contains(s.Evidence, "UnknownError") || !strings.Contains(s.Reason, "退出码 1") {
		t.Errorf("证据应是那行报错、原因带退出码：%+v", s)
	}
	// 从日志尾巴一路判到标记：三段现场样本都标「工具+模型@机器」且到期解除，干了活的不标
	agyQuota := `{"event":"result","result":{"status":"ERROR","error":"Individual quota reached"}}`
	marks := []struct {
		worker, tail, target string
		ok                   bool
	}{
		{"opencode+deepseek-v4.1-flash", unknown, "opencode+deepseek-v4.1-flash@h1", true},
		{"agy+gemini-3.8-flash-high", agyQuota, "agy+gemini-3.8-flash-high@h1", true},
		{"codex+gpt-6-sol", `{"type":"turn.started"}`, "codex+gpt-6-sol@h1", true},
		{"opencode+deepseek-v4.1-flash", read("testdata/opencode-sample.jsonl") + unknown, "", false},
	}
	for _, c := range marks {
		w, _ := ParseWorker(c.worker)
		m, ok := MarkOf(Classify(1, c.worker, LogTail{Text: c.tail}, now), w, "h1", now)
		if ok != c.ok || (ok && (m.Target() != c.target || m.Until != now.Add(Hold).UnixMilli())) {
			t.Errorf("%s：%v %+v", c.worker, ok, m)
		}
	}
}

// 退出时挑哪条报错来判：从日志文件经 Tail 读尾巴再判，覆盖两种挑错行——出错事件之后的收尾噪音、尾巴开头截断的半行。
func TestClassifyPicksReport(t *testing.T) {
	now := time.Date(2026, 9, 30, 14, 21, 0, 0, time.UTC)
	dir := t.TempDir()
	read := func(f string) string {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	// codex 做过事、退出时打的收尾噪音（t744 现场那一行的写法）
	noise := "2026-09-30T14:21:07.512345Z ERROR codex_core::session: failed to record rollout items: thread 0199e0a1-5c2d-7a13-9f4e-3b8d2c6a1e70 not found\n"
	worked := read("testdata/codex-sample.jsonl")
	failed := func(msg string) string {
		return `{"type":"error","message":"` + msg + `"}` + "\n" + `{"type":"turn.failed","error":{"message":"` + msg + `"}}` + "\n" + noise
	}
	// t696：一条超长的工具输出跨过尾巴开头，截断的半行里有额度字样，之后没有别的报错行
	long := `{"type":"item.completed","item":{"id":"item_9","type":"command_execution","command":"cat signals.go","aggregated_output":"` +
		strings.Repeat("a", TailBytes-40) + ` Error: rate limit exceeded ` + strings.Repeat("b", 60) + `","exit_code":0,"status":"completed"}}` + "\n"
	cases := []struct {
		name, worker, log string
		code              int
		kind, evidence    string
		cut               bool
		reset             time.Time
	}{
		// t744 第 1 次拉起（codex@h1）日志末尾：容量报错之后是收尾噪音
		{"t744 容量报错被收尾噪音跟着", "codex+gpt-6-sol", read("testdata/codex-t744-run1-tail.txt"), 1, SignalTransient, "at capacity", false, time.Time{}},
		{"t696 截断半行里的额度字样不算", "codex+gpt-6-sol", worked + long + `{"type":"turn.started"}` + "\n", 1, SignalTransient, "", true, time.Time{}},
		{"额度报错被收尾噪音跟着", "codex+gpt-6-sol", worked + failed("You've hit your usage limit. Try again in ~90 min."), 1, SignalQuota, "usage limit", false, now.Add(90 * time.Minute)},
		{"没登录被收尾噪音跟着", "codex+gpt-6-sol", worked + failed("Not signed in. Please run codex login."), 1, SignalSetup, "Not signed in", false, time.Time{}},
		{"模型名无效被收尾噪音跟着", "codex+gpt-6-sol", failed("The 'gpt-nope' model is not supported when using Codex with a ChatGPT account."), 1, SignalModel, "gpt-nope", false, time.Time{}},
		{"截断之后仍认额度", "codex+gpt-6-sol", long + failed("You've hit your usage limit. Try again in ~90 min."), 1, SignalQuota, "usage limit", true, now.Add(90 * time.Minute)},
	}
	for i, c := range cases {
		path := filepath.Join(dir, fmt.Sprintf("run-%d.log", i))
		if err := os.WriteFile(path, []byte(c.log), 0o600); err != nil {
			t.Fatal(err)
		}
		log, err := Tail(path, TailBytes)
		if err != nil {
			t.Fatal(err)
		}
		if log.Cut != c.cut || strings.Contains(log.Text, "aaaa") {
			t.Errorf("%s：截断 %v，要 %v；开头半行应已丢掉", c.name, log.Cut, c.cut)
		}
		s := Classify(c.code, c.worker, log, now)
		if s.Kind != c.kind || !strings.Contains(s.Evidence, c.evidence) || strings.Contains(s.Evidence, "rollout") || strings.Contains(s.Evidence, "rate limit") {
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
	pi, _ := Builtin("pi")
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
		{pi, `{"type":"agent_settled"}`, true, true},
		{pi, `{"type":"auto_retry_end","success":false,"finalError":"upstream service timeout"}`, true, false},
		{pi, `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"跑完了"}]}}`, false, false},
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
	if s := pi.SessionOf(`{"type":"session","version":3,"id":"01a0fd13-a325-7380-bb9e-e5468c2deb20","cwd":"/x"}`); s != "01a0fd13-a325-7380-bb9e-e5468c2deb20" {
		t.Errorf("pi 会话 id：%q", s)
	}
	if r := pi.LastReply(`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"审阅结论：通过"}]}}` + "\n" + `{"type":"agent_settled"}`); r != "审阅结论：通过" {
		t.Errorf("pi 最后回复：%q", r)
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
		{"额度用尽读不出恢复时刻", Signal{Kind: SignalQuota}, true, "agy+claude-opus-4-6-thinking@h3", now.Add(Hold).UnixMilli()},
		{"没登录标整个工具、等人处理", Signal{Kind: SignalSetup, Reason: "没登录"}, true, "agy@h3", 0},
		{"缺运行环境标整个工具、等人处理", Signal{Kind: SignalSetup, Reason: "缺运行环境"}, true, "agy@h3", 0},
		{"模型名无效等人处理", Signal{Kind: SignalModel}, true, "agy+claude-opus-4-6-thinking@h3", 0},
		{"临时错误不标", Signal{Kind: SignalTransient}, false, "", 0},
		{"零步骤出错退出标工具+模型、到期解除", Signal{Kind: SignalNoStart, Reason: "零步骤出错退出（退出码 1，原因不明）"}, true, "agy+claude-opus-4-6-thinking@h3", now.Add(Hold).UnixMilli()},
		{"思考耗尽不标", Signal{Kind: SignalThinking}, false, "", 0},
	}
	for _, c := range cases {
		m, ok := MarkOf(c.sig, agy, "h3", now)
		if ok != c.ok || (ok && (m.Target() != c.target || m.Until != c.until || m.Reason == "" || (c.sig.Reason != "" && m.Reason != c.sig.Reason))) {
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
		{Tool: "grok", Host: "h3", Kind: SignalSetup, Reason: "没登录"},
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

// 自检标记：不过的记上、跑通的解除；同一「工具@机器」已有别的标记（没登录）不覆盖也不解除；别台的不动。
func TestSyncProbes(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now().UnixMilli()
	if err := SetMark(ctx, db, Mark{Tool: "grok", Host: "h3", Kind: SignalSetup, Reason: "没登录", Since: now}); err != nil {
		t.Fatal(err)
	}
	probe := func(tool, reason string) Mark { return Mark{Tool: tool, Kind: MarkProbe, Reason: reason} }
	list := func() string {
		ms, err := Marks(ctx, db, now)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, m := range ms {
			out = append(out, m.Target()+" "+m.Kind+" "+m.Reason)
		}
		return strings.Join(out, " | ")
	}
	steps := []struct {
		host   string
		failed []Mark
		want   string
	}{
		{"h3", []Mark{probe("codex", "退出码 1"), probe("grok", "退出码 2")},
			"codex@h3 probe 退出码 1 | grok@h3 setup 没登录"},
		{"h1", []Mark{probe("codex", "超时")},
			"codex@h1 probe 超时 | codex@h3 probe 退出码 1 | grok@h3 setup 没登录"},
		{"h3", []Mark{probe("codex", "退出码 9")},
			"codex@h1 probe 超时 | codex@h3 probe 退出码 9 | grok@h3 setup 没登录"},
		{"h3", nil, "codex@h1 probe 超时 | grok@h3 setup 没登录"},
	}
	for i, s := range steps {
		if err := SyncProbes(ctx, db, s.host, s.failed, now); err != nil {
			t.Fatal(err)
		}
		if got := list(); got != s.want {
			t.Errorf("第 %d 步：%s", i+1, got)
		}
	}
	if got := (Mark{Tool: "codex", Host: "h1", Kind: MarkProbe, Reason: "自检 codex --version 退出码 1"}).Text(); got != "自检 codex --version 退出码 1，修好后自检跑通自动解除，或 atrium workers edit --clear codex@h1" {
		t.Error(got)
	}
}

// 新出现一条等人处理的标记才推给秘书；同一种刷新、自检碰上别的标记、会自己恢复的都不推。
func TestSettle(t *testing.T) {
	setup := Mark{Kind: SignalSetup, Reason: "没登录", Since: 1}
	probe := Mark{Kind: MarkProbe, Reason: "自检 kimi --version 退出码 1", Since: 1}
	quota := Mark{Kind: SignalQuota, Reason: "额度用尽", Until: 9, Since: 1}
	cases := []struct {
		name         string
		prev         *Mark
		next         Mark
		write, fresh bool
	}{
		{"没有标记时新记等人处理的", nil, setup, true, true},
		{"没有标记时新记自检不过", nil, probe, true, true},
		{"额度用尽不推", nil, quota, true, false},
		{"同一种等人处理的刷新不算新", &setup, Mark{Kind: SignalSetup, Reason: "缺运行环境", Since: 5}, true, false},
		{"自检每轮刷新不算新", &probe, Mark{Kind: MarkProbe, Reason: "自检 kimi --version 退出码 2", Since: 5}, true, false},
		{"自检不覆盖没登录", &setup, probe, false, false},
		{"自检不覆盖额度用尽", &quota, probe, false, false},
		{"额度用尽之后没登录算新", &quota, setup, true, true},
		{"自检不过之后查出没登录算新", &probe, setup, true, true},
		{"模型名无效换成没登录算新", &Mark{Kind: SignalModel, Reason: "模型名无效"}, setup, true, true},
	}
	for _, c := range cases {
		out, write, fresh := settle(c.prev, c.next)
		if write != c.write || fresh != c.fresh {
			t.Errorf("%s：write=%v fresh=%v", c.name, write, fresh)
		}
		if keep := write && !fresh && c.next.Until == 0; keep && out.Since != c.prev.Since {
			t.Errorf("%s：刷新应沿用原来的 since，得 %d", c.name, out.Since)
		}
	}
}

// 推给秘书的事件：新出现一条推一条（去重键按目标），刷新与额度用尽不推；秘书确认后解除再出现，再推一条。
func TestMarkEvents(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now().UnixMilli()
	list := func() string {
		rows, err := db.QueryContext(ctx, `SELECT target, level, key, count, body FROM events WHERE kind = ? ORDER BY id`, events.WorkerDown)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var target, level, key, body string
			var n int
			rows.Scan(&target, &level, &key, &n, &body)
			out = append(out, fmt.Sprintf("%s %s %s %d %s", target, level, key, n, body))
		}
		return strings.Join(out, " | ")
	}
	kimi := Mark{Tool: "kimi", Host: "h3", Kind: SignalSetup, Reason: "没登录", Since: now}
	one := `secretary act worker:kimi@h3 1 {"next":"登录或装好运行环境后 atrium workers edit --clear kimi@h3","reason":"没登录","target":"kimi@h3"}`
	steps := []struct {
		name string
		do   func() error
		want string
	}{
		{"额度用尽不推", func() error {
			return SetMark(ctx, db, Mark{Tool: "kimi", Model: "k2", Host: "h3", Kind: SignalQuota, Reason: "额度用尽", Until: now + 3600_000, Since: now})
		}, ""},
		{"没登录推一条", func() error { return SetMark(ctx, db, kimi) }, one},
		{"再记一次同样的不推", func() error { return SetMark(ctx, db, kimi) }, one},
		{"自检碰上没登录不覆盖也不推", func() error {
			return SyncProbes(ctx, db, "h3", []Mark{{Tool: "kimi", Reason: "自检 kimi --version 退出码 1"}}, now)
		}, one},
		{"确认、解除后再没登录，再推一条", func() error {
			if _, err := db.ExecContext(ctx, `UPDATE events SET acked_at = ?`, now); err != nil {
				return err
			}
			if _, err := ClearMarks(ctx, db, "kimi@h3"); err != nil {
				return err
			}
			return SetMark(ctx, db, kimi)
		}, one + " | " + one},
	}
	for _, s := range steps {
		if err := s.do(); err != nil {
			t.Fatal(err)
		}
		if got := list(); got != s.want {
			t.Errorf("%s：%s", s.name, got)
		}
	}
	// 自检不过的每轮刷新，只推第一次。
	for range 3 {
		if err := SyncProbes(ctx, db, "h1", []Mark{{Tool: "codex", Reason: "自检 codex --version 退出码 1"}}, now); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	db.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE key = 'worker:codex@h1' AND count = 1`).Scan(&n)
	if n != 1 {
		t.Errorf("自检标记应只推一条：%d", n)
	}
}
