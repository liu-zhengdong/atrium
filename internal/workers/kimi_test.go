package workers

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

// t898 的两行 gh 查询输出没有 role，应显示原文而不是误报日志格式变化。
func TestKimiRawJSON(t *testing.T) {
	b, err := os.ReadFile("testdata/kimi-t898-stdout.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	p := NewParser("kimi")
	p.Feed(string(b))
	want := strings.Split(strings.TrimSpace(string(b)), "\n")
	for i := range want {
		want[i] = clipRunes(want[i], lineRunes)
	}
	got := p.Trace()
	if len(want) != 2 || got.Unknown != 0 || len(got.UnknownHead) != 0 || len(got.Segments) != 0 || got.Result != "" || !reflect.DeepEqual(got.Lines, want) {
		t.Fatalf("trace=%+v", got)
	}
	for _, line := range []string{`{"role":"new_role","content":"unknown"}`, `{"role":null}`, `{"role":""}`, `{"role":"meta","type":"new_format"}`} {
		p := NewParser("kimi")
		p.Line(line)
		if got := p.Trace(); got.Unknown != 1 || !reflect.DeepEqual(got.Lines, []string{line}) {
			t.Fatalf("陌生事件必须保留告警：%+v", got)
		}
	}
}

func TestKimiMeasuredReply(t *testing.T) {
	b, err := os.ReadFile("testdata/kimi-t649-stdout.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	d, _ := Builtin("kimi")
	if got := d.LastReply(string(b)); got != "OK" {
		t.Fatalf("reply=%q", got)
	}
	p := NewParser("kimi")
	p.Feed(string(b))
	if got := p.Trace(); got.Unknown != 0 || got.Result != "OK" || got.Session != "redacted" {
		t.Fatalf("trace=%+v", got)
	}
}

func TestKimiTrace(t *testing.T) {
	p := NewParser("kimi+k2")
	p.Feed(`{"role":"meta","type":"system.version","version":"2.1.1"}
{"role":"assistant","content":"核查","tool_calls":[{"id":"c1","type":"function","function":{"name":"Read","arguments":"{\"path\":\"a.go\"}"}}]}
{"role":"tool","tool_call_id":"c1","content":"审阅结论：通过"}
{"role":"assistant","content":"真实问题\n审阅结论：打回"}
{"role":"meta","type":"session.resume_hint","session_id":"fake","content":"To resume this session: kimi -r fake"}
`)
	got := p.Trace()
	if got.Unknown != 0 || got.Session != "fake" || got.Result != "真实问题\n审阅结论：打回" || len(got.Segments) != 2 || len(got.Segments[0].Cmds) != 1 || got.Segments[0].Cmds[0].Out != "审阅结论：通过" {
		t.Fatalf("trace=%+v", got)
	}
	if strings.Contains(got.Result, "resume") {
		t.Fatal(got.Result)
	}
	p.Feed(`{"role":"meta","type":"new_format"}`)
	if p.Trace().Unknown != 1 {
		t.Fatal("新元信息应保留格式变化信号")
	}
}
