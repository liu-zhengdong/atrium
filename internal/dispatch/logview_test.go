package dispatch

import (
	"os"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 跟着看（逐行喂、每行后打新定下来的部分）与一次看完打出的文本一样：不重复、不漏、不乱序。
func TestTracePrinter(t *testing.T) {
	cases := []struct {
		worker, log string
		has         []string
		once        string // 最后一句与结果同文，只出现一次
	}{
		{"dsh", "dsh-sample.jsonl", []string{"printf hi", "hi", "输出原样如下"}, "输出原样如下"},
	}
	for _, c := range cases {
		raw, err := os.ReadFile("../workers/testdata/" + c.log)
		if err != nil {
			t.Fatal(err)
		}
		whole := workers.NewParser(c.worker)
		whole.Feed(string(raw))
		want := (&tracePrinter{}).next(whole.Trace(), true)

		p, pr := workers.NewParser(c.worker), &tracePrinter{}
		var got strings.Builder
		for _, l := range strings.Split(string(raw), "\n") {
			p.Line(l)
			got.WriteString(pr.next(p.Trace(), false))
		}
		got.WriteString(pr.next(p.Trace(), true))
		if got.String() != want {
			t.Errorf("%s 跟着看：\n%s\n一次看完：\n%s", c.log, got.String(), want)
		}
		for _, s := range c.has {
			if !strings.Contains(want, s) {
				t.Errorf("%s 缺 %q：\n%s", c.log, s, want)
			}
		}
		if strings.Count(want, c.once) != 1 {
			t.Errorf("%s 最后一句与结果重复了", c.log)
		}
	}
}

// 带解析的工具日志里有没认出的事件：文本里写明几行，原文跟在后面。
func TestTracePrinterUnknown(t *testing.T) {
	p := workers.NewParser("dsh")
	p.Feed(`{"type":"text","text":"好"}` + "\n" + `{"type":"brand.new"}`)
	got := (&tracePrinter{}).next(p.Trace(), true)
	if !strings.Contains(got, "== 有 1 行事件没认出（工具的日志格式可能变了），原文在下面\n\n== 其他输出\n{\"type\":\"brand.new\"}") {
		t.Errorf("%s", got)
	}
}

func TestCmdLine(t *testing.T) {
	if got := cmdLine("cat <<'EOF'\n  a\nEOF"); got != "cat <<'EOF' ↵ a ↵ EOF" {
		t.Errorf("%q", got)
	}
	if got := cmdLine(strings.Repeat("长", 200)); len([]rune(got)) != cmdWidth+1 {
		t.Errorf("没截断：%d", len([]rune(got)))
	}
}
