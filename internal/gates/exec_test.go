package gates_test

import (
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/gates"
)

func TestCmdError(t *testing.T) {
	const omitted = "\n…\n"
	cause := errors.New("exit status 7")
	const root = "FATAL: No usable sandbox!\n"
	const last = "\nERROR: final failure detail!"
	head := root + strings.Repeat("h", 400-len(root))
	tail := strings.Repeat("t", 800-len(last)) + last
	for _, c := range []struct {
		name, stderr, want string
	}{
		{"empty", "", ""},
		{"whitespace", " \r\n\t", ""},
		{"short", " \r\n错误：短输出\r\n详情\t ", "错误：短输出\r\n详情"},
		{"old-limit", strings.Repeat("x", 800), strings.Repeat("x", 800)},
		{"above-old-limit", strings.Repeat("x", 801), strings.Repeat("x", 801)},
		{"below-limit", strings.Repeat("x", 1199), strings.Repeat("x", 1199)},
		{"at-limit", head + tail, head + tail},
		{"above-limit", head + "!" + tail, head + omitted + tail},
		{"root-at-start", head + strings.Repeat("\nstack frame", 1000) + strings.Repeat("t", 800), head + omitted + strings.Repeat("t", 800)},
		{"root-at-end", strings.Repeat("h", 400) + strings.Repeat("\nstack frame", 1000) + tail, strings.Repeat("h", 400) + omitted + tail},
		{"both-ends", " \r\n" + head + "MIDDLE-MUST-DISAPPEAR" + tail + "\r\n ", head + omitted + tail},
		{"utf8-boundaries", strings.Repeat("中", 500), strings.Repeat("中", 133) + omitted + strings.Repeat("中", 266)},
		{"utf8-four-byte", "a" + strings.Repeat("🙂", 500) + "z", "a" + strings.Repeat("🙂", 99) + omitted + strings.Repeat("🙂", 199) + "z"},
	} {
		t.Run(c.name, func(t *testing.T) {
			e := &gates.CmdError{Cmd: "test-command", Stderr: c.stderr, Err: cause}
			got := e.Error()
			const prefix = "test-command：exit status 7："
			if got != prefix+c.want {
				t.Fatalf("错误摘要不符：\ngot  %q\nwant %q", got, prefix+c.want)
			}
			if len(got)-len(prefix) > 1205 || !utf8.ValidString(got) {
				t.Fatalf("摘要必须不超过 1205 字节且为有效 UTF-8：%q", got)
			}
			if e.Stderr != c.stderr || !errors.Is(e, cause) {
				t.Fatal("格式化不得改变原始 stderr 或底层错误")
			}
		})
	}
}
