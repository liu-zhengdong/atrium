package dispatch

import (
	"os"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 跟着看（逐行喂、每行后打新定下来的部分）与一次看完打出的文本一样：不重复、不漏、不乱序。
func TestTracePrinter(t *testing.T) {
	raw, err := os.ReadFile("../workers/testdata/claude-t308.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	whole := workers.NewParser("claude")
	whole.Feed(string(raw))
	want := (&tracePrinter{}).next(whole.Trace(), true)

	p, pr := workers.NewParser("claude"), &tracePrinter{}
	var got strings.Builder
	for _, l := range strings.Split(string(raw), "\n") {
		p.Line(l)
		got.WriteString(pr.next(p.Trace(), false))
	}
	got.WriteString(pr.next(p.Trace(), true))
	if got.String() != want {
		t.Errorf("跟着看：\n%s\n一次看完：\n%s", got.String(), want)
	}
	for _, s := range []string{"\n先看代码\n  ✓ ls internal/platform internal/hosts && grep", "\n开始改代码：", "\n== 结果（用时 5 分钟）\n两处都修好了"} {
		if !strings.Contains(want, s) {
			t.Errorf("缺 %q：\n%s", s, want)
		}
	}
	if strings.Count(want, "两处都修好了") != 1 {
		t.Errorf("最后一句与结果重复了")
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
