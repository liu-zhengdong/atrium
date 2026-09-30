package workers

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestTraceGrokLog(t *testing.T) {
	tr, err := ReadTrace("grok", "testdata/grok-messages.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	want := Trace{Segments: []Segment{{Say: "我先读取当前目录里的 probe.txt。", Cmds: []Command{{Cmd: "read_file probe.txt", State: CmdOK, Out: "1→t561 sample"}}}}, Ended: true, Result: "`probe.txt` 只有一行：`t561 sample`。", Model: "grok-4.7", Ms: 23889}
	if !reflect.DeepEqual(tr, want) {
		t.Fatalf("得到 %+v", tr)
	}
}

// t677 原始压缩边界：grok 与 Claude 共用处理，不显示、不改变会话或收尾。
func TestTraceCompactBoundary(t *testing.T) {
	log, err := os.ReadFile("testdata/grok-t677-compact.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"grok", "claude"} {
		t.Run(tool, func(t *testing.T) {
			p := NewParser(tool)
			p.Feed(`{"type":"system","subtype":"init","session_id":"original","model":"model"}
{"type":"assistant","message":{"content":[{"type":"text","text":"完成"}]}}
{"type":"result","result":"完成","duration_ms":42}`)
			want := p.Trace()
			p.Feed(string(log))
			if got := p.Trace(); !reflect.DeepEqual(got, want) {
				t.Fatalf("压缩边界改变经过：得到 %+v，期望 %+v", got, want)
			}
			if tool == "grok" {
				p.Feed(strings.ReplaceAll(string(log), "compact_boundary", "compact_boundary_new"))
				if got := p.Trace(); got.Unknown != 1 || len(got.UnknownHead) != 1 || len(got.Lines) != 1 {
					t.Fatalf("未知系统事件应报告：%+v", got)
				}
			}
		})
	}
}

func TestTraceGrokEvents(t *testing.T) {
	p := NewParser("grok")
	p.Feed(`{"type":"assistant","message":{"content":[{"type":"text","text":"执行命令"},{"type":"tool_use","id":"a","name":"run_terminal_command","input":{"command":"rg absent"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a","is_error":true,"content":"Exit code 1"}]}}
{"type":"stream_event"}
{"type":"system","subtype":"new"}
{"type":"assistant","message":{"content":[{"type":"new"}]}}
{"type":"user","message":{"content":[{"type":"new"}]}}
{"type":"new"}`)
	tr := p.Trace()
	if tr.Unknown != 4 || len(tr.Segments) != 1 || tr.Segments[0].Cmds[0].Cmd != "rg absent" || tr.Segments[0].Cmds[0].State != CmdNone {
		t.Fatalf("得到 %+v", tr)
	}
}

// Windows 上真实 Messages 输出：工具结果保留它报出的嵌套 JSON 原文。
func TestTraceGrokWindowsLog(t *testing.T) {
	tr, err := ReadTrace("grok", "testdata/grok-messages-windows.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Unknown != 0 || len(tr.Lines) != 0 || len(tr.Segments) != 1 || !tr.Ended || tr.Model != "grok-4.7" || tr.Ms != 7855 || tr.Result != "`probe.txt` contains one line: `t561 sample`." {
		t.Fatalf("得到 %+v", tr)
	}
	s := tr.Segments[0]
	if s.Say != "I'll read `probe.txt` in the current directory and report its one line." || len(s.Cmds) != 1 {
		t.Fatalf("分段 %+v", s)
	}
	c := s.Cmds[0]
	if c.Cmd != "read_file probe.txt" || c.State != CmdOK || !strings.Contains(c.Out, `"content":"1→t561 sample\n"`) {
		t.Fatalf("工具 %+v", c)
	}
}

// 真实日志（t649 的 grok，三行精简）：server_tool_use（web_search）是真实一步要显示，
// web_search_tool_result 是网址列表认出但不展开；thinking 认出不显示。
func TestTraceGrokServerTool(t *testing.T) {
	tr, err := ReadTrace("grok", "testdata/grok-t649.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Unknown != 0 || tr.Ended || len(tr.Segments) != 1 {
		t.Fatalf("得到 %+v", tr)
	}
	var searches []Command
	for _, c := range tr.Segments[0].Cmds {
		if strings.HasPrefix(c.Cmd, "web_search ") {
			searches = append(searches, c)
		}
	}
	if len(searches) != 3 {
		t.Fatalf("应有 3 条 web_search，得到 %+v", tr.Segments[0].Cmds)
	}
	for _, c := range searches {
		if c.State != CmdOK || c.Out != "" {
			t.Errorf("命令 %+v", c)
		}
	}
}

func TestReadTracePartialLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.log")
	if err := os.WriteFile(path, []byte("完整行\n最后半行"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"kimi", "my-cli", "grok", "claude"} {
		tr, err := ReadTrace(tool, path)
		want := []string{"完整行"}
		if readerOf(tool) == nil {
			want = append(want, "最后半行")
		}
		if err != nil || !reflect.DeepEqual(tr.Lines, want) {
			t.Errorf("%s: %+v, %v", tool, tr, err)
		}
	}
}

// 真实日志（t308，精简过）：开头没说话先跑命令，中间四句话切段，最后一句与收尾总结同文并进结果。
func TestTraceClaudeLog(t *testing.T) {
	tr, err := ReadTrace("claude+opus:high", "testdata/claude-t308.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	var says []string
	cmds := 0
	for _, s := range tr.Segments {
		says = append(says, s.Say)
		cmds += len(s.Cmds)
		for _, c := range s.Cmds {
			if c.State != CmdOK || strings.Count(c.Out, "\n") >= outLines {
				t.Errorf("命令 %q：%s，输出 %d 行", c.Cmd, c.State, strings.Count(c.Out, "\n")+1)
			}
		}
	}
	if len(says) != 5 || says[0] != "" || !strings.HasPrefix(says[1], "开始改代码") || !strings.HasPrefix(says[4], "隔离实例里本机 CLI 探测正常") {
		t.Errorf("分段：%q", says)
	}
	if cmds != 25 || !strings.HasPrefix(tr.Segments[0].Cmds[0].Cmd, "ls internal/platform internal/hosts && grep") {
		t.Errorf("命令 %d 条，第一条 %q", cmds, tr.Segments[0].Cmds[0].Cmd)
	}
	if !tr.Ended || tr.Ms != 294212 || !strings.HasPrefix(tr.Result, "两处都修好了，已开 PR [#521") || len(tr.Lines) != 0 {
		t.Errorf("收尾：%v %d %q %q", tr.Ended, tr.Ms, firstPara(tr.Result), tr.Lines)
	}
}

func TestTraceClaudeEvents(t *testing.T) {
	log := strings.Join([]string{
		`{"type":"system","subtype":"init","session_id":"x"}`,
		`{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"…"},{"type":"text","text":"先搜一下"},{"type":"tool_use","id":"a","name":"Bash","input":{"command":"grep -rn foo internal"}},{"type":"tool_use","id":"b","name":"Bash","input":{"command":"rg bar /nope"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a","content":"Exit code 1","is_error":true},{"type":"tool_result","tool_use_id":"b","content":"Exit code 2\nrg: /nope: No such file","is_error":true}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c","name":"Agent","input":{"description":"查"}}]},"parent_tool_use_id":null}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"子代理的话不算"},{"type":"tool_use","id":"s1","name":"Bash","input":{"command":"ls"}}]},"parent_tool_use_id":"c"}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c","content":[{"type":"text","text":"查到了"}]}]}}`,
		`Error: something on stderr`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"做完了。\n\n细节"}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"duration_ms":60000,"result":"做完了。\n\n细节"}`,
		`{"type":"user","isReplay":true,"message":{"content":"再加一条"}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"收到补充"},{"type":"tool_use","id":"d","name":"Bash","input":{"command":"go test ./..."}}]}}`,
	}, "\n")
	p := NewParser("claude")
	p.Feed(log)
	tr := p.Trace()
	got := func(s Segment) []string {
		var out []string
		for _, c := range s.Cmds {
			out = append(out, c.State+" "+c.Cmd)
		}
		return out
	}
	if len(tr.Segments) != 3 || tr.Segments[0].Say != "先搜一下" || tr.Segments[1].Say != "做完了。\n\n细节" || tr.Segments[2].Say != "收到补充" {
		t.Fatalf("分段：%+v", tr.Segments)
	}
	want := []string{"none grep -rn foo internal", "err rg bar /nope", "ok Agent 查"}
	if g := got(tr.Segments[0]); !reflect.DeepEqual(g, want) || tr.Segments[0].Cmds[2].Out != "查到了" {
		t.Errorf("命令：%q", g)
	}
	if g := got(tr.Segments[2]); !reflect.DeepEqual(g, []string{"run go test ./..."}) {
		t.Errorf("在跑的命令：%q", g)
	}
	if tr.Ended || tr.Result != "" || !reflect.DeepEqual(tr.Lines, []string{"Error: something on stderr"}) {
		t.Errorf("补充说明后接着干，前一次收尾作废：%+v", tr)
	}
}

func TestTraceCodexLog(t *testing.T) {
	tr, err := ReadTrace("codex", "testdata/codex-sample.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	want := Trace{
		Usage: Usage{Tokens: Tokens{Input: token(100), Output: token(20), CacheRead: token(0)}},
		Segments: []Segment{
			{Cmds: []Command{{Cmd: "ls internal", State: CmdOK, Out: "api\napp\ncli"}, {Cmd: "rg -n 'ReadLog' internal/web", State: CmdNone}}},
			{Say: "先改解析，再补测试。", Cmds: []Command{
				{Cmd: "file_change add internal/workers/trace.go", State: CmdOK},
				{Cmd: "go test ./internal/workers/", State: CmdErr, Out: "--- FAIL: TestTrace\nFAIL"}}},
		},
		Ended:  true,
		Result: "已开 PR [#9 解析经过](https://github.com/o/r/pull/9)。\n\n- 加了解析\n- 删了旧的",
	}
	if !reflect.DeepEqual(tr, want) {
		t.Errorf("得到 %+v", tr)
	}
}

// 实际模型取工具在开头报的：claude、cursor 在 system init，agy 在 init；codex --json 不报。
func TestModelOf(t *testing.T) {
	read := func(f string) string {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	claude := `{"type":"system","subtype":"hook_started","hook_id":"h"}` + "\n" +
		`{"type":"system","subtype":"init","cwd":"/r","session_id":"717b9af2-4989-4044-86f8-ce8adffa1a8b","model":"claude-opus-5-5"}` + "\n"
	cases := []struct{ worker, head, want string }{
		{"claude+opus", claude, "claude-opus-5-5"},
		{"cursor+auto", read("testdata/cursor-t347.jsonl"), "Auto"},
		{"agy+gemini-3.8-flash-high", read("testdata/agy-t349.jsonl"), "gemini-3.8-flash-high"},
		{"codex", read("testdata/codex-sample.jsonl"), ""},
		{"kimi", "Model: k2\n", ""},
	}
	for _, c := range cases {
		if got := ModelOf(c.worker, c.head); got != c.want {
			t.Errorf("%s：得到 %q，应为 %q", c.worker, got, c.want)
		}
	}
}

// 真实日志（t349）：agy 只报步骤不带话，23 个工具步骤攒成开头一段；执行者被补充说明重启，没有收尾。
func TestTraceAgyLog(t *testing.T) {
	tr, err := ReadTrace("agy+gemini-3.8-flash-high", "testdata/agy-t349.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.Segments) != 1 || tr.Segments[0].Say != "" || len(tr.Segments[0].Cmds) != 23 || tr.Ended || len(tr.Lines) != 0 {
		t.Fatalf("得到 %+v", tr)
	}
	cmds := tr.Segments[0].Cmds
	for _, c := range cmds {
		if c.State != CmdOK || strings.Contains(c.Out, "\r") || strings.Count(c.Out, "\n") >= outLines {
			t.Errorf("命令 %q：%s，输出 %q", c.Cmd, c.State, c.Out)
		}
	}
	if cmds[0] != (Command{Cmd: "git status", State: CmdOK, Out: "On branch task-t349\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean"}) ||
		cmds[1].Cmd != "view_file internal/README.md" || cmds[1].Out != "191 lines, 24478 bytes" {
		t.Errorf("前两条：%+v", cmds[:2])
	}
}

func TestTraceAgyEvents(t *testing.T) {
	log := strings.Join([]string{
		`{"event":"init","init":{"model":"m"}}`,
		`{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response"}}`,
		`{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/r/nope.go"}}}}`,
		`{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/r/nope.go"},"error":{"type":"TOOL_ERROR","message":"stat /r/nope.go: no such file or directory"}}}}`,
		`{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"先"}}`,
		`{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"读代码"}}`,
		`{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"agent_response"}}`,
		`{"event":"step_update","step_update":{"step_index":5,"state":"DONE","step_type":"subagent","tool_name":"invoke_subagent","subagent_info":{"subagents":[{"role":"读设计"},{"role":"读测试"}]}}}`,
		`{"event":"step_update","step_update":{"step_index":7,"state":"DONE","step_type":"brand_new_step"}}`,
		`{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"go test ./..."},"output":"ok\r\n"}}}`,
		`{"event":"step_update","step_update":{"step_index":6,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"gh pr create"}}}}`,
		`{"event":"result","result":{"status":"ERROR","error":"boom"}}`,
	}, "\n")
	p := NewParser("agy")
	p.Feed(log)
	tr := p.Trace()
	want := Trace{Segments: []Segment{{Cmds: []Command{
		{Cmd: "view_file /r/nope.go", State: CmdErr, Out: "stat /r/nope.go: no such file or directory"},
	}}, {Say: "先读代码", Cmds: []Command{
		{Cmd: "subagent 读设计、读测试", State: CmdOK},
		{Cmd: "go test ./...", State: CmdOK, Out: "ok"},
		{Cmd: "gh pr create", State: CmdRun},
	}}}, Model: "m", Unknown: 1, UnknownHead: []string{`{"event":"step_update","step_update":{"step_index":7,"state":"DONE","step_type":"brand_new_step"}}`}, Lines: []string{
		`{"event":"step_update","step_update":{"step_index":7,"state":"DONE","step_type":"brand_new_step"}}`,
		`{"event":"result","result":{"status":"ERROR","error":"boom"}}`,
	}}
	if !reflect.DeepEqual(tr, want) {
		t.Errorf("得到 %+v", tr)
	}
	p.Feed(`{"event":"step_update","step_update":{"step_index":8,"state":"DONE","step_type":"agent_response","text_delta":"已开 PR。\n\n细节"}}
{"event":"result","result":{"status":"SUCCESS","response":"先读代码\n已开 PR。\n\n细节","duration_seconds":61.5}}`)
	if tr := p.Trace(); !tr.Ended || tr.Result != "已开 PR。\n\n细节" || tr.Ms != 61500 || len(tr.Segments) != 2 {
		t.Errorf("收尾（response 连着说过的话，总结取最后一句）：%+v", tr)
	}
}

// 真实日志（t347，精简过输出）：cursor 说一句跑一串，70 条调用里读文件、改文件写成「工具名 路径」，一条 ffmpeg 出错。
func TestTraceCursorLog(t *testing.T) {
	tr, err := ReadTrace("cursor+auto", "testdata/cursor-t347.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	var cmds []Command
	for _, s := range tr.Segments {
		cmds = append(cmds, s.Cmds...)
	}
	if len(tr.Segments) != 19 || tr.Segments[0].Say != "先读动画技能和相关文件。" || len(cmds) != 70 {
		t.Fatalf("%d 段、%d 条命令，第一段 %q", len(tr.Segments), len(cmds), tr.Segments[0].Say)
	}
	errs, edit := 0, false
	for _, c := range cmds {
		edit = edit || c.Cmd == "edit src/openquota/data.ts"
		if c.State == CmdErr {
			errs++
			if !strings.HasPrefix(c.Out, "Unrecognized option 'vsync'.") {
				t.Errorf("出错的命令 %q：%q", c.Cmd, c.Out)
			}
		}
	}
	if errs != 1 || cmds[0].Cmd != "read /Users/liuzhengdong/.atrium-v2/skills/animation/r1/SKILL.md" || !edit ||
		!strings.HasPrefix(cmds[1].Cmd, "ls /Users/liuzhengdong/.atrium-v2/skills/animation/r1/; git log") {
		t.Errorf("出错 %d 条，改文件写成相对路径 %v；%q %q", errs, edit, cmds[0].Cmd, cmds[1].Cmd)
	}
	if !tr.Ended || tr.Ms != 772574 || !strings.HasPrefix(tr.Result, "OpenQuota 宣传片做完了") || tr.Unknown != 0 || len(tr.Lines) != 0 {
		t.Errorf("收尾（result 连着说过的话，总结取最后一句）：%v %d %q %d %q", tr.Ended, tr.Ms, firstPara(tr.Result), tr.Unknown, tr.Lines)
	}
}

// 真实日志（t476，精简过输出）：抓网页前的授权请求与应答（interaction_query）认出但不显示，抓取本身是 webFetch 步骤。
func TestTraceCursorInteraction(t *testing.T) {
	tr, err := ReadTrace("cursor+auto", "testdata/cursor-t476.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	var cmds []string
	for _, c := range tr.Segments[0].Cmds {
		cmds = append(cmds, c.State+" "+c.Cmd)
	}
	want := []string{"ok webFetch https://linear.app/docs", "ok webFetch https://www.notion.com/help",
		"ok webFetch https://vercel.com/docs/getting-started-with-vercel", "ok webFetch https://support.stripe.com/"}
	if len(tr.Segments) != 1 || !reflect.DeepEqual(cmds, want) || tr.Unknown != 0 || len(tr.Lines) != 0 || !tr.Ended {
		t.Errorf("%d 段，命令 %q，%d 行没认出 %q", len(tr.Segments), cmds, tr.Unknown, tr.Lines)
	}
}

// 按 opencode 1.18 源码（run --format json）造的样本：tool_use 完成时一次报齐，bash 的退出码在 metadata.exit，step_finish stop 收尾。
func TestTraceOpencodeLog(t *testing.T) {
	tr, err := ReadTrace("opencode+m", "testdata/opencode-sample.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	want := Trace{
		Usage: Usage{Tokens: Tokens{Input: token(6200), Output: token(190), CacheRead: token(0), CacheWrite: token(0)}},
		Segments: []Segment{
			{Cmds: []Command{
				{Cmd: "ls internal", State: CmdOK, Out: "api\napp\ncli"},
				{Cmd: "read /tmp/opencode-r/internal/README.md", State: CmdOK, Out: "<file>\n00001| # 包\n</file>"}}},
			{Say: "先改解析，再补测试。", Cmds: []Command{
				{Cmd: "edit /tmp/opencode-r/internal/workers/trace.go", State: CmdOK, Out: "Edit applied successfully."},
				{Cmd: "grep Traceable /tmp/opencode-r/internal", State: CmdOK, Out: "No files found"},
				{Cmd: "read /tmp/opencode-r/nope.go", State: CmdErr, Out: "File not found: /tmp/opencode-r/nope.go"},
				{Cmd: "go test ./internal/workers/", State: CmdErr, Out: "--- FAIL: TestTrace\nFAIL"}}},
		},
		Ended:  true,
		Result: "已开 PR [#9 解析经过](https://github.com/o/r/pull/9)。\n\n- 加了解析\n- 删了旧的",
	}
	if !reflect.DeepEqual(tr, want) {
		t.Errorf("得到 %+v", tr)
	}
}

// 每个输出 JSON 事件的内置工具都得带解析、有样本，样本里没有认不出的事件；纯文本工具不带解析。
func TestTraceEveryJSONTool(t *testing.T) {
	for _, tool := range Tools {
		d, _ := Builtin(tool)
		if !d.JSON {
			if d.read != nil {
				t.Errorf("%s 输出纯文本，不该带解析", tool)
			}
			continue
		}
		samples, _ := filepath.Glob("testdata/" + tool + "-*.jsonl")
		if d.read == nil || len(samples) == 0 {
			t.Errorf("%s 输出 JSON 事件：要在 Driver.read 带解析（tracers.go），并放一份真实日志 testdata/%s-*.jsonl", tool, tool)
		}
		segments := 0
		for _, f := range samples {
			tr, err := ReadTrace(tool, f)
			segments += len(tr.Segments)
			if err != nil || tr.Unknown != 0 {
				t.Errorf("%s：%v，%d 行没认出，%d 段", f, err, tr.Unknown, len(tr.Segments))
			}
		}
		if segments == 0 {
			t.Errorf("%s 的日志样本缺少可显示的经过", tool)
		}
	}
}

// 带解析的工具：没认出的事件记数并留原文，不是 JSON 的行（stderr）只留原文。
func TestTraceUnknown(t *testing.T) {
	p := NewParser("cursor")
	p.Feed(`{"type":"tool_call","subtype":"started","call_id":"a","tool_call":{"shellToolCall":{"args":{"command":"ls"}}}}
{"type":"tool_call","subtype":"completed","call_id":"a","tool_call":{"shellToolCall":{"args":{"command":"ls"},"result":{"rejected":{"reason":"no"}}}}}
{"type":"tool_call","subtype":"started","call_id":"b","tool_call":{"globToolCall":{"args":{"globPattern":"*.go"}}}}
{"type":"brand_new","x":1}
{"type":"tool_call","subtype":"started","call_id":"c","tool_call":{"what":{}}}
warning: something`)
	tr := p.Trace()
	want := Trace{Segments: []Segment{{Cmds: []Command{
		{Cmd: "ls", State: CmdErr, Out: `{"rejected":{"reason":"no"}}`},
		{Cmd: `glob {"globPattern":"*.go"}`, State: CmdRun},
	}}}, Unknown: 2, UnknownHead: []string{`{"type":"brand_new","x":1}`, `{"type":"tool_call","subtype":"started","call_id":"c","tool_call":{"what":{}}}`}, Lines: []string{`{"type":"brand_new","x":1}`, `{"type":"tool_call","subtype":"started","call_id":"c","tool_call":{"what":{}}}`, "warning: something"}}
	if !reflect.DeepEqual(tr, want) {
		t.Errorf("得到 %+v", tr)
	}
}

// 不带解析的工具：逐行留原文，只留最后 rawLines 行，不记「没认出」。
func TestTraceRawTool(t *testing.T) {
	p := NewParser("kimi+m")
	for i := 0; i < 100; i++ {
		p.Line(`{"type":"text","part":{"text":"x"}}`)
	}
	p.Line("最后一行")
	tr := p.Trace()
	if len(tr.Segments) != 0 || tr.Unknown != 0 || len(tr.Lines) != rawLines || tr.Lines[rawLines-1] != "最后一行" || Traceable("kimi") || Traceable("my-cli") || !Traceable("cursor+auto:high") {
		t.Errorf("%+v", tr)
	}
}

func TestCmdState(t *testing.T) {
	cases := []struct {
		cmd  string
		code int
		want string
	}{
		{"go test ./...", 0, CmdOK},
		{"go test ./...", 1, CmdErr},
		{"grep -rn x .", 1, CmdNone},
		{"cd internal && rg x", 1, CmdNone},
		{"grep -rn x .", 2, CmdErr},
		{"grep x a | head", 1, CmdNone},
		{"git grep x", 1, CmdErr},
		{"rg x", -1, CmdErr},
	}
	for _, c := range cases {
		if got := CmdState(c.cmd, c.code); got != c.want {
			t.Errorf("%q %d → %s", c.cmd, c.code, got)
		}
	}
}

func TestUnwrapShell(t *testing.T) {
	cases := map[string]string{
		`bash -lc 'ls -la'`:              "ls -la",
		`/bin/zsh -lc 'echo '\''hi'\'''`: "echo 'hi'",
		`bash -lc "rg -n \"a b\" ."`:     `rg -n "a b" .`,
		`bash -lc 'a' && 'b'`:            `bash -lc 'a' && 'b'`,
		`ls -la`:                         "ls -la",
	}
	for in, want := range cases {
		if got := unwrapShell(in); got != want {
			t.Errorf("%q → %q，应为 %q", in, got, want)
		}
	}
}
