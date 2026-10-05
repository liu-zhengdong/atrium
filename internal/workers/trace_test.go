package workers

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestReadTracePartialLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.log")
	if err := os.WriteFile(path, []byte("完整行\n最后半行"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"dsh", "my-cli"} {
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

func TestModelOf(t *testing.T) {
	b, err := os.ReadFile("testdata/dsh-sample.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct{ worker, head, want string }{
		// dsh 的日志不报模型：模型由拉起时的档案决定，不从日志里猜。
		{"dsh", string(b), ""},
		{"dsh+deepseek/deepseek-v4", `{"type":"session","sessionId":"session-x","cwd":"/r"}`, ""},
		{"my-cli", "Model: k2\n", ""},
	}
	for _, c := range cases {
		if got := ModelOf(c.worker, c.head); got != c.want {
			t.Errorf("%s：得到 %q，应为 %q", c.worker, got, c.want)
		}
	}
}

// 真实样本（dsh --profile headless --json 的第二次实测）：一步 bash 调用、两步用量相加、
// 终稿在 final 一行；会话 id 记裸 uuid（与 SessionOf 取到的同一份）。终稿与最后一段话同文，按 Trace 的规矩并进结果。
func TestTraceDshLog(t *testing.T) {
	tr, err := ReadTrace("dsh", "testdata/dsh-sample.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	want := Trace{Session: "1220f338-dc74-4155-ab4e-6396dfe66749",
		Usage: Usage{Tokens: Tokens{Input: token(4605), Output: token(146), CacheRead: token(14464), CacheWrite: token(0)}},
		Segments: []Segment{
			{Cmds: []Command{{Cmd: "printf hi", State: CmdOK, Out: "hi"}}},
		},
		Ended: true, Result: "输出原样如下：\n\n```\nhi\n```"}
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
	p := NewParser("dsh")
	p.Feed(`{"type":"brand_new","x":1}
{"type":"tool_call","tool":"bash","callId":"a","input":{"command":"ls"}}
{"type":"tool_result","callId":"a","status":"completed","result":"ok"}
{"type":"weird","y":2}
warning: something`)
	tr := p.Trace()
	want := Trace{Segments: []Segment{{Cmds: []Command{
		{Cmd: "ls", State: CmdOK, Out: "ok"},
	}}}, Unknown: 2, UnknownHead: []string{`{"type":"brand_new","x":1}`, `{"type":"weird","y":2}`}, Lines: []string{`{"type":"brand_new","x":1}`, `{"type":"weird","y":2}`, "warning: something"}}
	if !reflect.DeepEqual(tr, want) {
		t.Errorf("得到 %+v", tr)
	}
}

// 不带解析的工具：逐行留原文，只留最后 rawLines 行，不记「没认出」。
func TestTraceRawTool(t *testing.T) {
	p := NewParser("my-cli+m")
	for i := 0; i < 100; i++ {
		p.Line(`{"type":"text","part":{"text":"x"}}`)
	}
	p.Line("最后一行")
	tr := p.Trace()
	if len(tr.Segments) != 0 || tr.Unknown != 0 || len(tr.Lines) != rawLines || tr.Lines[rawLines-1] != "最后一行" || !Traceable("dsh") || Traceable("my-cli") || !Traceable("dsh+deepseek/deepseek-v4:high") {
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
