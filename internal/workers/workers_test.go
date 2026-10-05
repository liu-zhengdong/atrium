package workers

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestParseWorker(t *testing.T) {
	cases := []struct {
		in   string
		want Spec
		bad  bool
	}{
		{in: "dsh", want: Spec{Tool: "dsh"}},
		{in: "dsh:high", want: Spec{Tool: "dsh", Effort: "high"}},
		{in: "dsh+deepseek/deepseek-v4", want: Spec{Tool: "dsh", Model: "deepseek/deepseek-v4"}},
		{in: "dsh+opencode-go/mimo-v2.6-flash:low", want: Spec{Tool: "dsh", Model: "opencode-go/mimo-v2.6-flash", Effort: "low"}},
		{in: "dsh+zcode/GLM-5.3[1m]", want: Spec{Tool: "dsh", Model: "zcode/GLM-5.3[1m]"}},
		{in: "dsh+GLM-5.3[1m]:high", want: Spec{Tool: "dsh", Model: "GLM-5.3[1m]", Effort: "high"}},
		{in: "Dsh", bad: true},
		{in: "dsh+", bad: true},
		{in: "dsh+a b", bad: true},
		{in: "dsh+../x", bad: true},
		{in: "dsh:HIGH", bad: true},
		// 方括号档位后缀只在段尾、至多一个，里面不嵌方括号。
		{in: "dsh+glm[1m", bad: true},
		{in: "dsh+glm[1m][2m]", bad: true},
		{in: "dsh+[1m]glm", bad: true},
		{in: "dsh+glm[]", bad: true},
		{in: "dsh+glm[1[m]]", bad: true},
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
		{tool: "dsh", in: in("", ""), want: []string{"--profile", "headless", "--json", "-"}},
		{tool: "dsh", in: in("deepseek-official/deepseek-pro", "high"), want: []string{"--profile", "headless", "--patch", filepath.Join(dir, "dsh-model.yml"), "--json", "-"}},
		{tool: "dsh", in: Request{Prompt: "x", PromptFile: pf, Dir: dir, Session: "0123abcd-0123-0123-0123-0123456789ab"}, want: []string{"--session-id", "session-0123abcd-0123-0123-0123-0123456789ab", "-"}},
		{tool: "dsh", in: in("deepseek-pro", ""), bad: "要写 provider/模型"},
		{tool: "dsh", in: in("", "high"), bad: "要写模型才能给思考强度"},
		{tool: "dsh", in: Request{Prompt: "x", PromptFile: pf, Dir: "rel"}, bad: "绝对路径"},
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
	// dsh 的模型覆盖层：patch 整份替换 agent-default-model 的 config，provider 与 model 都要给。
	d, _ := Builtin("dsh")
	dl, derr := d.Build(in("deepseek-official/deepseek-pro", "high"))
	if derr != nil {
		t.Fatal(derr)
	}
	src := dl.Files[filepath.Join(dir, "dsh-model.yml")]
	for _, want := range []string{"provider: deepseek-official", "model: deepseek-pro", "reasoningEffort: high"} {
		if !strings.Contains(src, want) {
			t.Errorf("dsh 覆盖层里没有 %s：%q", want, src)
		}
	}
	// dsh 走标准输入接提示词文件，命令行里不带正文；权限模式由环境变量给足。
	l, err := d.Build(in("", ""))
	if err != nil {
		t.Fatal(err)
	}
	if l.StdinFile != pf {
		t.Errorf("dsh StdinFile=%q", l.StdinFile)
	}
	if l.Env["DSH_PERMISSION_MODE"] != "danger-full-access" {
		t.Errorf("dsh Env=%v", l.Env)
	}
}

func TestLocalOnly(t *testing.T) {
	for endpoint, local := range map[string]bool{
		"":                         false,
		"http://127.0.0.1:3425/v1": true,
		"http://127.8.0.1/v1":      true,
		"http://localhost:3425":    true,
		"http://[::1]:3425/v1":     true,
		"https://open.bigmodel.cn": false,
		"http://10.0.0.2:3425/v1":  false,
		"http://localhost.evil.cn": false,
	} {
		if got := (Resolved{Rules: Rules{Endpoint: endpoint}}).LocalOnly(); (got != "") != local {
			t.Errorf("%q → %q", endpoint, got)
		}
	}
}

// 提示词永远走标准输入或提示词文件，不拼进命令行：Windows 的批处理包装有 8191 字节上限。
func TestWindowsBatchLongPrompt(t *testing.T) {
	dir := t.TempDir()
	for _, prompt := range []string{"第一行\n第二行", strings.Repeat("长说明", 10000)} {
		req := Request{Dir: dir, PromptFile: filepath.Join(dir, "prompt.md"), Prompt: prompt}
		l, err := Build("dsh", req)
		if err != nil {
			t.Fatalf("dsh Build: %v", err)
		}
		line, err := platform.BatchCommandLine("", `C:\\bin\\dsh.cmd`, l.Args)
		if err != nil || strings.Contains(line, prompt) || len(line) >= 8191 {
			t.Fatalf("Windows 命令行含说明或过长: len=%d err=%v", len(line), err)
		}
		if l.StdinFile != req.PromptFile {
			t.Fatal("dsh 未接提示词文件到 stdin")
		}
	}
	if _, err := platform.BatchCommandLine("", `C:\\bin\\dsh.cmd`, []string{"--json", "第一行\n第二行"}); err == nil {
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
func TestProfileEdit(t *testing.T) {
	src := "---\ntrust: medium\nchecks: [pr_exists]\n---\n先跑相关测试。\n"
	out, err := ApplyEdit("combos/dsh+deepseek-v4", "", Edit{Source: &src})
	if err != nil || !strings.Contains(out, "先跑相关测试。") {
		t.Fatalf("%q %v", out, err)
	}
	out, err = ApplyEdit("combos/dsh+deepseek-v4", out, Edit{Set: map[string]string{"max_risk": "high", "checks": "[]"}, Unset: []string{"trust"}})
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
		{"harness/dsh", Edit{Set: map[string]string{"trust": "super"}}, "trust 只能是"},
		{"harness/dsh", Edit{Set: map[string]string{"colour": "red"}}, "规则写得不对"},
		{"harness/dsh", Edit{Set: map[string]string{"limits": "{max_tasks: 1}"}}, "field limits not found"},
		{"harness/nope", Edit{Set: map[string]string{"trust": "low"}}, "不是内置工具"},
		{"harness/dsh", Edit{Set: map[string]string{"endpoint": "ftp://x", "endpoint_api": "openai"}}, "http(s)"},
		{"combos/dsh", Edit{Set: map[string]string{"trust": "low"}}, "档案名应为"},
		{"skills/x", Edit{Set: map[string]string{"trust": "low"}}, "档案名应为"},
		{"combos/dsh+glm[1m", Edit{Set: map[string]string{"trust": "low"}}, "档案名应为"},
		{"combos/dsh+glm[1m][2m]", Edit{Set: map[string]string{"trust": "low"}}, "档案名应为"},
		{"harness/dsh", Edit{Unset: []string{"trust"}}, "没有 trust"},
	}
	for _, c := range bad {
		if _, err := ApplyEdit(c.name, "", c.e); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s %+v：应报 %q，得到 %v", c.name, c.e, c.want, err)
		}
	}
}

func TestCheckName(t *testing.T) {
	ok := []string{
		"harness/dsh",
		"models/deepseek-v4",
		"models/GLM-5.3[1m]",
		"models/zcode/GLM-5.3[1m]",
		"combos/dsh+deepseek-v4",
		"combos/dsh+GLM-5.3[1m]",
		"combos/dsh+zcode/GLM-5.3[1m]",
		"combos/dsh+deepseek-official/deepseek-pro",
		"harness/my-tool.v2",
	}
	bad := []string{
		"",
		"harness",
		"harness/",
		"models/",
		"combos/",
		"harness/.dsh",
		"models/.glm",
		"models/GLM-5.3[1m",
		"models/GLM-5.3[1m][2m]",
		"models/[1m]",
		"models/dsh+deepseek-v4",
		"harness/dsh+deepseek-v4",
		"combos/dsh",
		"combos/dsh+op+us",
		"combos/dsh+deepseek-v4:high",
		"skills/x",
	}
	for _, name := range ok {
		if err := CheckName(name); err != nil {
			t.Errorf("%q 应可建：%v", name, err)
		}
	}
	for _, name := range bad {
		if err := CheckName(name); err == nil {
			t.Errorf("%q 应拒绝", name)
		}
	}
}

func TestLegacySlashComboAddressable(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	// 旧库（渠道池时代）导入的组合名带 provider 前缀，模型串里的 / 曾被当分层符拒收，edit/--delete 都寻址不到。
	name := "combos/dsh+deepseek-official/deepseek-pro"
	if _, err := db.ExecContext(ctx, `INSERT INTO worker_profiles (name, spec, updated_by, updated_at) VALUES (?, ?, ?, ?)`,
		name, "---\ntrust: medium\n---\n旧组合\n", "u1", store.Now()); err != nil {
		t.Fatal(err)
	}
	d, err := Show(ctx, db, name)
	if err != nil || d.Profile == nil || d.Profile.Name != name {
		t.Fatalf("Show 应把带斜杠的组合名当档案：%+v %v", d, err)
	}
	if _, err := SaveProfile(ctx, db, name, Edit{Set: map[string]string{"trust": "low"}}, "u1"); err != nil {
		t.Fatalf("edit 应能寻址：%v", err)
	}
	if p, err := GetProfile(ctx, db, name); err != nil || p == nil || p.Keys["trust"] != "low" {
		t.Fatalf("改后原文：%+v %v", p, err)
	}
	if _, err := SaveProfile(ctx, db, name, Edit{Delete: true}, "u1"); err != nil {
		t.Fatalf("--delete 应能寻址：%v", err)
	}
	if p, err := GetProfile(ctx, db, name); err != nil || p != nil {
		t.Fatalf("删后应没有了：%+v %v", p, err)
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
	must("harness/dsh", "---\ntrust: low\nchecks: [finished]\nmodel: deepseek/deepseek-v4\n---\n工具层叮嘱")
	must("models/deepseek-v4", "---\ntrust: medium\n---\n模型层叮嘱")
	must("combos/dsh+deepseek-v4", "---\nmax_risk: high\nmodel: deepseek-official/deepseek-v4\n---\n组合层叮嘱")

	r, err := Resolve(ctx, db, "dsh+deepseek-v4:high")
	if err != nil {
		t.Fatal(err)
	}
	if r.ID != "dsh+deepseek-official/deepseek-v4:high" || r.CLIModel != "deepseek-official/deepseek-v4" ||
		r.Rules.Trust != "medium" || r.Rules.MaxRisk != "high" ||
		!reflect.DeepEqual(r.Rules.Checks, []string{"finished"}) || r.Body != "工具层叮嘱\n\n模型层叮嘱\n\n组合层叮嘱" ||
		!reflect.DeepEqual(r.Layers, []string{"harness/dsh", "models/deepseek-v4", "combos/dsh+deepseek-v4"}) {
		t.Fatalf("叠加：%+v", r)
	}
	detail, err := Show(ctx, db, "dsh+deepseek-v4:high")
	if err != nil || len(detail.Layers) != 3 {
		t.Fatalf("Show 各层原文：%+v %v", detail, err)
	}
	for i, name := range r.Layers {
		p, err := GetProfile(ctx, db, name)
		if err != nil || !reflect.DeepEqual(detail.Layers[i], *p) {
			t.Fatalf("第 %d 层原文不一致：%v", i, err)
		}
	}
	// 档案写的模型与标识里的只差 provider 前缀：两种写法是同一个执行者，ID 按档案写的。
	must("combos/dsh+deepseek-v4.1-flash", "---\nmodel: deepseek-official/deepseek-v4.1-flash\n---\n")
	for _, id := range []string{"dsh+deepseek-v4.1-flash", "dsh+deepseek-official/deepseek-v4.1-flash"} {
		r, err := Resolve(ctx, db, id)
		if err != nil || r.Spec.Model != "deepseek-official/deepseek-v4.1-flash" || r.CLIModel != r.Spec.Model {
			t.Errorf("%s：%+v %v", id, r, err)
		}
	}
	// 目录里只留档案归一后的那一行。
	if rows, _ := List(ctx, db); slices.ContainsFunc(rows, func(r Row) bool { return r.ID == "dsh+deepseek-v4.1-flash" }) {
		t.Errorf("目录里还有不带前缀的那行：%+v", rows)
	}
	// magpie 组合：模型名带方括号档位后缀（GLM-5.3[1m]），标识带不带 provider 前缀都归同一身份；
	// 额度绑定按 magpie 路由名第一段（zcode），回环端点只派本机。
	must("combos/dsh+GLM-5.3[1m]", "---\nmodel: zcode/GLM-5.3[1m]\nendpoint: http://127.0.0.1:3425/v1\nendpoint_api: anthropic\n---\n")
	for _, id := range []string{"dsh+GLM-5.3[1m]", "dsh+zcode/GLM-5.3[1m]"} {
		r, err := Resolve(ctx, db, id)
		if err != nil || r.ID != "dsh+zcode/GLM-5.3[1m]" || r.CLIModel != "zcode/GLM-5.3[1m]" {
			t.Errorf("%s：%+v %v", id, r, err)
			continue
		}
		b := MagpieBinding(r, "h1", quota.MagpieURL)
		if b == nil || b.Provider != "zcode" || b.Host != "h1" || b.Worker != r.ID {
			t.Errorf("%s 额度绑定：%+v", id, b)
		}
		if r.LocalOnly() == "" {
			t.Errorf("%s 回环端点应只派本机：%q", id, r.LocalOnly())
		}
	}
	// 只写工具：模型取 harness 的 model，再经档案归一。
	r, _ = Resolve(ctx, db, "dsh")
	if r.ID != "dsh+deepseek-official/deepseek-v4" || r.Rules.EffectiveMaxRisk() != "high" {
		t.Fatalf("只写工具：%+v", r)
	}
	if r.Rules.EffectiveTrust() != "medium" || r.Rules.EffectiveMaxRisk() != "high" {
		t.Fatal("trust 取模型层、max_risk 取组合层")
	}
	if _, err := Resolve(ctx, db, "mytool"); err == nil {
		t.Fatal("非内置工具应拒绝")
	}
	ids, _ := Catalog(ctx, db)
	if !slices.Contains(ids, "dsh+GLM-5.3[1m]") {
		t.Fatalf("目录：%v", ids)
	}
	rows, err := List(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	i := slices.IndexFunc(rows, func(r Row) bool { return r.ID == "dsh+deepseek-official/deepseek-v4" })
	if i < 0 || rows[i].Trust != "medium" {
		t.Fatalf("列表：%+v", rows)
	}
}

func TestCatalogClosedByCombos(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	save := func(name, src string) {
		t.Helper()
		if _, err := SaveProfile(ctx, db, name, Edit{Source: &src}, "u1"); err != nil {
			t.Fatal(err)
		}
	}
	// 一条组合档案都没有：候选就是唯一的执行者裸名。
	ids, err := Catalog(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ids, []string{"dsh"}) {
		t.Fatalf("没配组合时应列执行者裸名：%v", ids)
	}
	save("combos/dsh+deepseek/deepseek-v4", "---\nmodel: deepseek/deepseek-v4\n---\n")
	// 配了组合就是封闭池：只列这些组合，执行者裸名退出候选。
	ids, err = Catalog(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ids, []string{"dsh+deepseek/deepseek-v4"}) {
		t.Fatalf("配了组合应封闭：%v", ids)
	}
	// 点名不受封闭影响：写死执行者与技能的优先执行者都不经过目录。
	if _, err := Resolve(ctx, db, "dsh"); err != nil {
		t.Fatalf("点名的执行者仍应能解析：%v", err)
	}
	// 组合删光又回到执行者裸名。
	if _, err := SaveProfile(ctx, db, "combos/dsh+deepseek/deepseek-v4", Edit{Delete: true}, "u1"); err != nil {
		t.Fatal(err)
	}
	ids, err = Catalog(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(ids, "dsh") {
		t.Fatalf("删掉组合后应回到执行者裸名：%v", ids)
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
		{"额度带恢复间隔", 1, "working\nERROR: You've hit your usage limit. Try again in ~90 min.\n", SignalQuota, now.Add(90 * time.Minute)},
		{"429", 1, "Error: HTTP/1.1 429 Too Many Requests\nretry-after: 30\n", SignalQuota, now.Add(30 * time.Second)},
		{"dsh 轮次内的额度报文", 1, `{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"code":"RATE_LIMITED","message":"You've hit your usage limit. Try again in ~5 min."}}}`, SignalQuota, now.Add(5 * time.Minute)},
		// dsh 的默认 provider（DeepSeek，按 API key 计费）余额不足的真实报文：按额度用尽处置
		{"dsh 余额不足算额度用尽", 1, `{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"code":"insufficient_quota","message":"Insufficient Balance"}}}`, SignalQuota, time.Time{}},
		{"正文提到额度不算", 1, `{"type":"text","text":"usage limit reached"}`, SignalTransient, time.Time{}},
		{"退出码 0 不判额度", 0, "Error: usage limit reached\n", SignalNone, time.Time{}},
		// 认不出的出错退出不按措辞分：数不出步骤（非内置工具）或做过事的都按临时错误重试
		{"网络", 1, "Error: fetch failed\n", SignalTransient, time.Time{}},
		{"过载事件", 1, `{"type":"error","message":"Overloaded"}`, SignalTransient, time.Time{}},
		{"容量不足", 1, `{"type":"error","message":"Selected model is at capacity. Please try a different model."}`, SignalTransient, time.Time{}},
		{"没登录（纯文本）", 1, "Not signed in\n", SignalSetup, time.Time{}},
		// dsh 的默认 provider key 失效（Authentication Fails…api key is invalid）按没登录处置，不当临时错误反复重试
		{"dsh key 失效算没登录", 1, `{"type":"error","message":"Error: Authentication Fails, Your api key is invalid"}`, SignalSetup, time.Time{}},
		{"退出码 0 不判没登录", 0, "Not signed in\n", SignalNone, time.Time{}},
		{"Node 没选版本", 1, "No active Node.js version is configured\n", SignalSetup, time.Time{}},
		{"zsh 找不到命令", 127, "zsh: command not found: mytool\n", SignalSetup, time.Time{}},
		{"bash 找不到命令", 127, "bash: line 1: mytool: command not found\n", SignalSetup, time.Time{}},
		{"dash 找不到命令", 127, "/bin/sh: 1: mytool: not found\n", SignalSetup, time.Time{}},
		{"shebang 找不到 node", 127, "env: node: No such file or directory\n", SignalSetup, time.Time{}},
		{"Windows 找不到命令", 1, "'mytool' 不是内部或外部命令，也不是可运行的程序\n或批处理文件。\n", SignalSetup, time.Time{}},
		{"Windows 英文找不到命令", 1, "'mytool' is not recognized as an internal or external command,\noperable program or batch file.\n", SignalSetup, time.Time{}},
		{"拉起子进程 ENOENT", 1, "Error: spawn mytool ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:285:19)\n", SignalSetup, time.Time{}},
		{"Go 找不到可执行文件", 1, `exec: "mytool": executable file not found in $PATH` + "\n", SignalSetup, time.Time{}},
		{"退出码 0 不判缺运行环境", 0, "zsh: command not found: rg\n", SignalNone, time.Time{}},
		{"读不到文件不算缺运行环境", 1, "Error: ENOENT: no such file or directory, open 'a.txt'\n", SignalTransient, time.Time{}},
		{"RESOURCE_EXHAUSTED 带恢复时长", 1, "API error (attempt 5): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h57m45s\n", SignalQuota, now.Add(2*time.Hour + 57*time.Minute + 45*time.Second)},
		{"纯文本 quota reached", 1, "Individual quota reached\n", SignalQuota, time.Time{}},
		{"quota 在后", 1, "Error: You exceeded your current quota, please check your plan\n", SignalQuota, time.Time{}},
		{"下划线连写", 1, "Error: quota_exceeded\n", SignalQuota, time.Time{}},
		{"限定词 limit 在前", 1, "Error: Rate limit hit\n", SignalQuota, time.Time{}},
		{"上下文 limit 不算额度", 1, "Error: context limit reached\n", SignalTransient, time.Time{}},
		{"余额不足", 1, "Error: insufficient balance\n", SignalQuota, time.Time{}},
		{"负载均衡器不算余额", 1, "Error: load balancer exhausted retries\n", SignalTransient, time.Time{}},
		{"单词里的 hit 不算", 1, "Error: whitelist quota config missing\n", SignalTransient, time.Time{}},
		{"模型名无效（不给强度）", 1, `invalid model selection (--model "gemini-3.8-flash" --effort "")` + "\n", SignalModel, time.Time{}},
		// dsh 报「选的模型有问题」的报文
		{"dsh 模型不存在", 1, `{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"code":"MODEL","message":"There's an issue with the selected model (dsh-nope). It may not exist or you may not have access to it."}}}`, SignalModel, time.Time{}},
		{"模型不支持", 1, "ERROR: The 'gpt-nope' model is not supported when using this account.\n", SignalModel, time.Time{}},
		{"退出码 0 不判模型名", 0, "invalid model selection\n", SignalNone, time.Time{}},
		{"继续跟进、没有报错收尾不判", ExitUnknown, "Error: fetch failed\n", SignalNone, time.Time{}},
		// dsh 的终稿（final）无论成败都写，成败看 turn_end 的 reason：中止的按做过事之后出错退出重试
		{"dsh 收尾被中止", 1, `{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"aborted"}}` + "\n" + `{"type":"final","text":""}`, SignalTransient, time.Time{}},
		{"dsh 继续跟进、报错收尾照判", ExitUnknown, `{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"aborted"}}`, SignalTransient, time.Time{}},
		{"dsh 继续跟进、报错收尾是额度", ExitUnknown, `{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"code":"RATE_LIMITED","message":"You've hit your usage limit. Try again in ~5 min."}}}`, SignalQuota, now.Add(5 * time.Minute)},
		{"之后正常收尾", 1, "Error: fetch failed\n" + `{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}`, SignalNone, time.Time{}},
		{"dsh 正常收尾不判", 1, `{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}` + "\n" + `{"type":"final","text":"好了"}`, SignalNone, time.Time{}},
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
	// dsh 只报了一条出错事件、一步没做（现场：拉起 1～2 秒就退出码 1）
	unknown := `{"type":"error","message":"UnknownError: Unexpected server error"}` + "\n"
	// 干过活之后才出错退出：日志尾巴里有工具调用，不算零步骤
	worked := `{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"ls"}}` + "\n" +
		`{"type":"error","message":"stream disconnected before completion"}` + "\n"
	cases := []struct {
		name, worker string
		code         int
		tail, kind   string
		cut          bool
	}{
		{"dsh 零步骤退出码 1", "dsh+deepseek-v4.1-flash", 1, unknown, SignalNoStart, false},
		{"日志是空的", "dsh", 1, "", SignalNoStart, false},
		{"干了活之后退出码 1 按临时错误重试", "dsh+deepseek-v4.1-flash", 1, worked, SignalTransient, false},
		{"退出码 0 不判", "dsh", 0, unknown, SignalNone, false},
		{"继续跟进拿不到退出码不判", "dsh", ExitUnknown, unknown, SignalNone, false},
		{"数不出步骤，按临时错误重试", "mycli", 1, "boom\n", SignalTransient, false},
		{"日志比尾巴长、尾巴里数不出步骤，按临时错误重试", "dsh", 1, unknown, SignalTransient, true},
		{"认得出的原因照原因判", "dsh", 1, `{"type":"error","message":"Error: Authentication Fails, Your api key is invalid"}`, SignalSetup, false},
	}
	for _, c := range cases {
		s := Classify(c.code, c.worker, LogTail{Text: c.tail, Cut: c.cut}, now)
		if s.Kind != c.kind {
			t.Errorf("%s：得到 %+v", c.name, s)
		}
	}
	if s := Classify(1, "dsh", LogTail{Text: unknown}, now); !strings.Contains(s.Evidence, "UnknownError") || !strings.Contains(s.Reason, "退出码 1") {
		t.Errorf("证据应是那行报错、原因带退出码：%+v", s)
	}
	// 从日志尾巴一路判到标记：零步骤与起不来的都标「工具[+模型]@机器」，干了活的不标
	marks := []struct {
		worker, tail, target string
		until                int64
		ok                   bool
	}{
		{"dsh+deepseek-v4.1-flash", unknown, "dsh+deepseek-v4.1-flash@h1", now.Add(Hold).UnixMilli(), true},
		{"dsh", `{"type":"error","message":"Error: Authentication Fails, Your api key is invalid"}`, "dsh@h1", 0, true},
		{"dsh+deepseek-v4.1-flash", worked, "", 0, false},
	}
	for _, c := range marks {
		w, _ := ParseWorker(c.worker)
		m, ok := MarkOf(Classify(1, c.worker, LogTail{Text: c.tail}, now), w, "h1", now)
		if ok != c.ok || (ok && (m.Target() != c.target || m.Until != c.until)) {
			t.Errorf("%s：%v %+v", c.worker, ok, m)
		}
	}
}

// dsh 在自己的出错事件里报了错、之后没写终稿：报错行被后面一大段输出挤出 Tail 的尾巴，
// Classify（退出码 0）判不出，要读整份日志（ReadTrace）才认得出，走 ReportedSignal。
func TestReportedSignalDshError(t *testing.T) {
	now := time.Date(2026, 10, 3, 19, 25, 0, 0, time.UTC)
	dshLog := func(msg string) string {
		return `{"type":"session","sessionId":"session-s1","cwd":"/w"}` + "\n" +
			`{"type":"error","message":` + strconv.Quote(msg) + `}` + "\n" +
			`{"type":"text","text":"` + strings.Repeat("x", TailBytes+1024) + `"}` + "\n"
	}
	cases := []struct{ name, log, kind, reason string }{
		{"额度", dshLog("Error: You've hit your usage limit."), SignalQuota, "额度用尽"},
		{"没登录", dshLog("Error: Authentication Fails, Your api key is invalid"), SignalSetup, "没登录"},
		{"认不出照旧空转", dshLog("500 Internal Server Error"), SignalNoStart, "静默空转：完整零 usage，且无有效动作或产出"},
	}
	for _, c := range cases {
		path := filepath.Join(t.TempDir(), "run-1.log")
		if err := os.WriteFile(path, []byte(c.log), 0o600); err != nil {
			t.Fatal(err)
		}
		tail, err := Tail(path, TailBytes)
		if err != nil {
			t.Fatal(err)
		}
		if s := Classify(0, "dsh", tail, now); s.Kind != SignalNone {
			t.Errorf("%s：退出码 0 时 Classify 应判不出，得到 %+v", c.name, s)
		}
		tr, err := ReadTrace("dsh", path)
		if err != nil {
			t.Fatal(err)
		}
		if tr.Error == "" {
			t.Errorf("%s：应读到执行者自己报的错", c.name)
			continue
		}
		s, ok := ReportedSignal(tr.Error, now)
		if !ok {
			s = SilentSignal(tr.Error)
		}
		if s.Kind != c.kind || s.Reason != c.reason {
			t.Errorf("%s：得到 %+v", c.name, s)
		}
	}
}

// 退出时挑哪条报错来判：从日志文件经 Tail 读尾巴再判，覆盖两种挑错行——出错事件之后的收尾噪音、尾巴开头截断的半行。
func TestClassifyPicksReport(t *testing.T) {
	now := time.Date(2026, 9, 30, 14, 21, 0, 0, time.UTC)
	dir := t.TempDir()
	worked := `{"type":"session","sessionId":"session-s1","cwd":"/w"}` + "\n" +
		`{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"cat signals.go"}}` + "\n" +
		`{"type":"tool_result","callId":"c1","status":"completed","result":"ok"}` + "\n"
	noise := "warning: failed to record rollout items: thread 0199e0a1 not found\n"
	failed := func(msg string) string {
		return `{"type":"error","message":` + strconv.Quote(msg) + `}` + "\n" + noise
	}
	// 一条超长的工具输出跨过尾巴开头，截断的半行里有额度字样，之后没有别的报错行
	long := `{"type":"tool_result","callId":"c2","status":"completed","result":"` +
		strings.Repeat("a", TailBytes-40) + ` Error: rate limit exceeded ` + strings.Repeat("b", 60) + `"}` + "\n"
	more := `{"type":"tool_call","callId":"c3","tool":"bash","input":{"command":"ls"}}` + "\n"
	cases := []struct {
		name, worker, log string
		code              int
		kind, evidence    string
		cut               bool
		reset             time.Time
	}{
		// 容量报错之后跟一条收尾噪音：不得盖过出错事件
		{"容量报错被收尾噪音跟着", "dsh", worked + failed("Selected model is at capacity. Please try a different model."), 1, SignalTransient, "at capacity", false, time.Time{}},
		{"截断半行里的额度字样不算", "dsh", worked + long + more, 1, SignalTransient, "", true, time.Time{}},
		{"额度报错被收尾噪音跟着", "dsh", worked + failed("You've hit your usage limit. Try again in ~90 min."), 1, SignalQuota, "usage limit", false, now.Add(90 * time.Minute)},
		{"没登录被收尾噪音跟着", "dsh", worked + failed("Not signed in. Please run dsh login."), 1, SignalSetup, "Not signed in", false, time.Time{}},
		{"模型名无效被收尾噪音跟着", "dsh", worked + failed("The 'gpt-nope' model is not supported when using this account."), 1, SignalModel, "gpt-nope", false, time.Time{}},
		{"截断之后仍认额度", "dsh", long + failed("You've hit your usage limit. Try again in ~90 min."), 1, SignalQuota, "usage limit", true, now.Add(90 * time.Minute)},
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
	dsh, _ := Builtin("dsh")
	cases := []struct {
		tail  string
		known bool
		ok    bool
	}{
		// dsh：终稿（final）无论成败都写，所以先认到 turn_end 的一行才算收尾，成败看 reason
		{`{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}` + "\n" + `{"type":"final","text":"好了"}`, true, true},
		{`{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"aborted"}}` + "\n" + `{"type":"final","text":""}`, true, false},
		{`{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"code":"X","message":"boom"}}}`, true, false},
		{`{"type":"status","phase":"step_end","turn":1,"usage":{"inputTokens":1}}`, false, false},
		{`{"type":"final","text":"好了"}`, false, false},
	}
	for _, c := range cases {
		e := dsh.Ended(c.tail)
		if e.Known != c.known || e.OK != c.ok {
			t.Errorf("%q → %+v", c.tail, e)
		}
	}
	if s := dsh.SessionOf(`{"type":"session","sessionId":"session-0123abcd-0123-0123-0123-0123456789ab","cwd":"/x"}`); s != "0123abcd-0123-0123-0123-0123456789ab" {
		t.Errorf("dsh 会话 id：%q", s)
	}
	if r := dsh.LastReply(`{"type":"text","text":"中间轮"}` + "\n" + `{"type":"final","text":"审阅结论：通过"}`); r != "审阅结论：通过" {
		t.Errorf("dsh 最后回复：%q", r)
	}
}

func TestMarkOf(t *testing.T) {
	now := time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)
	agy := Spec{Tool: "agy", Model: "claude-opus-4-6-thinking", Effort: "high"}
	reset := now.Add(3 * time.Hour).UnixMilli()
	cases := []struct {
		name      string
		sig       Signal
		ok        bool
		target    string
		until     int64
		openEnded bool
	}{
		{"额度用尽按报文恢复", Signal{Kind: SignalQuota, ResetAt: reset}, true, "agy+claude-opus-4-6-thinking@h3", reset, false},
		{"额度用尽读不出恢复时刻", Signal{Kind: SignalQuota}, true, "agy+claude-opus-4-6-thinking@h3", now.Add(Hold).UnixMilli(), true},
		{"没登录标整个工具、等人处理", Signal{Kind: SignalSetup, Reason: "没登录"}, true, "agy@h3", 0, false},
		{"缺运行环境标整个工具、等人处理", Signal{Kind: SignalSetup, Reason: "缺运行环境"}, true, "agy@h3", 0, false},
		{"模型名无效等人处理", Signal{Kind: SignalModel}, true, "agy+claude-opus-4-6-thinking@h3", 0, false},
		{"临时错误不标", Signal{Kind: SignalTransient}, false, "", 0, false},
		{"零步骤出错退出标工具+模型、到期解除", Signal{Kind: SignalNoStart, Reason: "零步骤出错退出（退出码 1，原因不明）"}, true, "agy+claude-opus-4-6-thinking@h3", now.Add(Hold).UnixMilli(), false},
		{"思考耗尽不标", Signal{Kind: SignalThinking}, false, "", 0, false},
		{"等订阅恢复不由退出信号判", Signal{Kind: MarkSubscription, Reason: "订阅已封号"}, false, "", 0, false},
	}
	for _, c := range cases {
		m, ok := MarkOf(c.sig, agy, "h3", now)
		if ok != c.ok || (ok && (m.Target() != c.target || m.Until != c.until || m.Reason == "" || (c.sig.Reason != "" && m.Reason != c.sig.Reason) || m.OpenEnded != c.openEnded)) {
			t.Errorf("%s：%v %+v", c.name, ok, m)
		}
	}
}

// 标记的一句话：报文写了恢复时刻的说「恢复」，没写的（OpenEnded）明说「报文没写恢复时刻、到点自动再试」，不拿 Hold 冒充恢复时刻。
func TestMarkText(t *testing.T) {
	now := time.Date(2026, 10, 3, 16, 17, 0, 0, time.Local)
	known := Mark{Tool: "codex", Host: "h1", Kind: SignalQuota, Reason: "额度用尽", Until: now.Add(4 * 24 * time.Hour).UnixMilli()}
	if got := known.Text(); got != "额度用尽，10-07 16:17 恢复" {
		t.Errorf("带恢复时刻：%q", got)
	}
	unknown := Mark{Tool: "grok", Host: "h3", Kind: SignalQuota, Reason: "额度用尽", Until: now.Add(Hold).UnixMilli(), OpenEnded: true}
	if got := unknown.Text(); got != "额度用尽，报文没写恢复时刻；10-03 20:17 起自动再试" {
		t.Errorf("无恢复信息：%q", got)
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

// 等订阅恢复：只从已有的有效标记转来（匹配同 --clear），since 与证据保留，不发 worker.down；文案不出登录指引。
func TestWaitSubscription(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now().UnixMilli()
	for _, m := range []Mark{
		{Tool: "claude", Host: "h1", Kind: SignalSetup, Reason: "没登录", Evidence: "OAuth token revoked", Since: now - 1000},
		{Tool: "claude", Host: "h3", Kind: SignalSetup, Reason: "没登录", Since: now},
		{Tool: "agy", Model: "old", Host: "h1", Kind: SignalQuota, Reason: "额度用尽", Until: now - 1, Since: now - 2},
	} {
		if err := SetMark(ctx, db, m); err != nil {
			t.Fatal(err)
		}
	}
	downs := func() int {
		var n int
		db.QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE kind = ?`, events.WorkerDown).Scan(&n)
		return n
	}
	before := downs()
	if _, err := WaitSubscription(ctx, db, "claude+bad model", now); err == nil || !strings.HasPrefix(err.Error(), "--wait-subscription:") {
		t.Errorf("写错的应以参数名开头报错：%v", err)
	}
	for _, c := range []struct {
		target string
		n      int64
	}{{"grok", 0}, {"agy+old@h1", 0}, {"claude@h1", 1}, {"claude", 2}} {
		if n, err := WaitSubscription(ctx, db, c.target, now); err != nil || n != c.n {
			t.Errorf("转 %s：%d %v", c.target, n, err)
		}
	}
	if got := downs(); got != before {
		t.Errorf("转等订阅恢复不该再发 worker.down：%d → %d", before, got)
	}
	ms, _ := Marks(ctx, db, now)
	if len(ms) != 2 {
		t.Fatalf("%+v", ms)
	}
	m := ms[0]
	if m.Target() != "claude@h1" || m.Kind != MarkSubscription || m.Until != 0 || m.Since != now-1000 || m.Evidence != "OAuth token revoked" {
		t.Errorf("转后的标记：%+v", m)
	}
	if _, ok := Blocked(ms, "claude", "opus", "h1"); !ok {
		t.Error("等订阅恢复照样挡活")
	}
	if got := m.Text(); got != "订阅已封号，等订阅恢复，用户明说后 atrium workers edit --clear claude@h1" {
		t.Error(got)
	}
	if got := (Mark{Tool: "claude", Model: "opus", Host: "h1", Kind: MarkSubscription, Reason: "订阅已封号"}).Fix(); got != "等订阅恢复，用户明说后 atrium workers edit --clear claude+opus@h1" {
		t.Error(got)
	}
	if n, _ := ClearMarks(ctx, db, "claude"); n != 2 {
		t.Errorf("--clear 仍能解除：%d", n)
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
	one := `secretary act worker:kimi@h3 1 {"next":"登录、装好或升级运行环境后 atrium workers edit --clear kimi@h3","reason":"没登录","target":"kimi@h3"}`
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
