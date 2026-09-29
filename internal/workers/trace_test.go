package workers

import (
	"reflect"
	"strings"
	"testing"
)

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
	want := []string{"none grep -rn foo internal", "err rg bar /nope", `ok Agent {"description":"查"}`}
	if g := got(tr.Segments[0]); !reflect.DeepEqual(g, want) || tr.Segments[0].Cmds[2].Out != "查到了" {
		t.Errorf("命令：%q", g)
	}
	if g := got(tr.Segments[2]); !reflect.DeepEqual(g, []string{"run go test ./..."}) {
		t.Errorf("在跑的命令：%q", g)
	}
	if tr.Ended || tr.Result != "" || !reflect.DeepEqual(tr.Lines, []string{"Error: something on stderr"}) {
		t.Errorf("捎话后接着干，前一次收尾作废：%+v", tr)
	}
}

func TestTraceCodexLog(t *testing.T) {
	tr, err := ReadTrace("codex+gpt-6-sol", "testdata/codex-sample.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	want := Trace{
		Segments: []Segment{
			{Cmds: []Command{{Cmd: "ls internal", State: CmdOK, Out: "api\napp\ncli"}, {Cmd: "rg -n 'ReadLog' internal/web", State: CmdNone}}},
			{Say: "先改解析，再补测试。", Cmds: []Command{
				{Cmd: `file_change [{"kind":"add","path":"internal/workers/trace.go"}]`, State: CmdOK},
				{Cmd: "go test ./internal/workers/", State: CmdErr, Out: "--- FAIL: TestTrace\nFAIL"}}},
		},
		Ended:  true,
		Result: "已开 PR [#9 解析经过](https://github.com/o/r/pull/9)。\n\n- 加了解析\n- 删了旧的",
	}
	if !reflect.DeepEqual(tr, want) {
		t.Errorf("得到 %+v", tr)
	}
}

// 真实日志（t349）：agy 只报步骤不带话，23 个工具步骤攒成开头一段；执行者被捎话重启，没有收尾。
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
		cmds[1].Cmd != `view_file {"AbsolutePath":"/Users/liuzhengdong/.atrium-v2/tasks/t349/repo/internal/README.md"}` || cmds[1].Out != "191 lines, 24478 bytes" {
		t.Errorf("前两条：%+v", cmds[:2])
	}
}

func TestTraceAgyEvents(t *testing.T) {
	log := strings.Join([]string{
		`{"event":"init","init":{"model":"m"}}`,
		`{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response"}}`,
		`{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/r/nope.go"}}}}`,
		`{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/r/nope.go"},"error":{"type":"TOOL_ERROR","message":"stat /r/nope.go: no such file or directory"}}}}`,
		`{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"go test ./..."},"output":"ok\r\n"}}}`,
		`{"event":"step_update","step_update":{"step_index":6,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"gh pr create"}}}}`,
		`{"event":"result","result":{"status":"ERROR","error":"boom"}}`,
	}, "\n")
	p := NewParser("agy")
	p.Feed(log)
	tr := p.Trace()
	want := Trace{Segments: []Segment{{Cmds: []Command{
		{Cmd: `view_file {"AbsolutePath":"/r/nope.go"}`, State: CmdErr, Out: "stat /r/nope.go: no such file or directory"},
		{Cmd: "go test ./...", State: CmdOK, Out: "ok"},
		{Cmd: "gh pr create", State: CmdRun},
	}}}, Lines: []string{`{"event":"result","result":{"status":"ERROR","error":"boom"}}`}}
	if !reflect.DeepEqual(tr, want) {
		t.Errorf("得到 %+v", tr)
	}
	p.Line(`{"event":"result","result":{"status":"SUCCESS","response":"已开 PR。\n\n细节"}}`)
	if tr := p.Trace(); !tr.Ended || tr.Result != "已开 PR。\n\n细节" {
		t.Errorf("收尾：%+v", tr)
	}
}

// 解析不了的工具：逐行留原文，只留最后 rawLines 行。
func TestTraceRawTool(t *testing.T) {
	p := NewParser("opencode+m")
	for i := 0; i < 100; i++ {
		p.Line(`{"type":"text","part":{"text":"x"}}`)
	}
	p.Line("最后一行")
	tr := p.Trace()
	if len(tr.Segments) != 0 || len(tr.Lines) != rawLines || tr.Lines[rawLines-1] != "最后一行" || Traceable("opencode") || !Traceable("codex+gpt:high") || !Traceable("agy+gemini-3.8-flash-high") {
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
