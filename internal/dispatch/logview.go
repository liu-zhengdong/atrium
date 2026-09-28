package dispatch

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 命令前的标记：成功、出错、没搜到、在跑。
var cmdMark = map[string]string{workers.CmdOK: "✓", workers.CmdErr: "✗", workers.CmdNone: "·", workers.CmdRun: "…"}

// cmdWidth 是文本版命令原文一行的上限（字符）。
const cmdWidth = 160

// tracePrinter 把经过打成文本（task log）：每段一句话，下面命令原文一行一条。跟着看时只打新定下来的部分：
// 最后一段的话等它有了命令或后面有了新段才打（它可能就是收尾总结），命令等有了结果才打；final 时全打出来。
type tracePrinter struct {
	seg, cmd int
	said     bool
}

func (p *tracePrinter) next(t workers.Trace, final bool) string {
	var b strings.Builder
	for ; p.seg < len(t.Segments); p.seg, p.cmd, p.said = p.seg+1, 0, false {
		s, last := t.Segments[p.seg], p.seg == len(t.Segments)-1
		if !p.said {
			if last && len(s.Cmds) == 0 && !final {
				return b.String()
			}
			say := s.Say
			if say == "" {
				say = "先看代码"
			}
			fmt.Fprintf(&b, "\n%s\n", say)
			p.said = true
		}
		for ; p.cmd < len(s.Cmds); p.cmd++ {
			c := s.Cmds[p.cmd]
			if c.State == workers.CmdRun && last && !final {
				return b.String()
			}
			fmt.Fprintf(&b, "  %s %s\n", cmdMark[c.State], cmdLine(c.Cmd))
		}
		if last && !final {
			return b.String()
		}
	}
	if !final {
		return b.String()
	}
	if t.Ended {
		b.WriteString("\n== 结果")
		if t.Ms > 0 {
			fmt.Fprintf(&b, "（用时 %d 分钟）", max((t.Ms+30000)/60000, 1))
		}
		fmt.Fprintf(&b, "\n%s\n", t.Result)
	}
	if len(t.Lines) > 0 {
		fmt.Fprintf(&b, "\n== 其他输出\n%s\n", strings.Join(t.Lines, "\n"))
	}
	return b.String()
}

var breakRE = regexp.MustCompile(`\s*\n\s*`)

// cmdLine 把命令原文压成一行：换行写成 ↵，超长截断。
func cmdLine(cmd string) string {
	s := breakRE.ReplaceAllString(strings.TrimSpace(cmd), " ↵ ")
	if r := []rune(s); len(r) > cmdWidth {
		return string(r[:cmdWidth]) + "…"
	}
	return s
}
