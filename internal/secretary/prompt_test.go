package secretary

import (
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/events"
)

func TestPromptBacklog(t *testing.T) {
	now := int64(24 * time.Hour / time.Millisecond)
	for _, tc := range []struct {
		name    string
		age     time.Duration
		label   string
		warning bool
	}{
		{"future", -time.Minute, "", false},
		{"fresh", 9 * time.Minute, "", false},
		{"ten minutes", 10 * time.Minute, "", false},
		{"over ten minutes", 10*time.Minute + time.Millisecond, "（积压 10 分钟）", false},
		{"minutes", 59 * time.Minute, "（积压 59 分钟）", false},
		{"one hour", time.Hour, "（积压 1 小时）", false},
		{"over one hour", time.Hour + time.Millisecond, "（积压 1 小时）", true},
		{"twelve hours", 12 * time.Hour, "（积压 12 小时）", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := row(7, now, "t3")
			r.At = now - tc.age.Milliseconds()
			for _, b := range []Batch{{Fresh: []events.Row{r}}, {Remind: []events.Row{r}}} {
				p := Prompt(b, now, RemindAfter, nil)
				if tc.label == "" && strings.Contains(p, "（积压") || tc.label != "" && !strings.Contains(p, events.Line(r, nil)+tc.label+"\n") {
					t.Fatalf("条龄不符：\n%s", p)
				}
				if strings.Contains(strings.Split(p, "\n")[0], "断线期间积了 1 条") != tc.warning {
					t.Fatalf("标题提醒不符：\n%s", p)
				}
			}
		})
	}
	fresh, old := row(7, now, "t3"), row(4, now, "t3")
	fresh.At, old.At = now, now-(12*time.Hour).Milliseconds()
	p := Prompt(Batch{Fresh: []events.Row{fresh}, Remind: []events.Row{old}}, now, RemindAfter, nil)
	for _, want := range []string{
		"【Atrium 事件】1 条要处理：断线期间积了 2 条，处理前先对照任务现状核实",
		events.Line(fresh, nil) + "\n", events.Line(old, nil) + "（积压 12 小时）\n",
		"送过 30 分钟还没确认：", "处理完确认：atrium events ack 7 4",
	} {
		if !strings.Contains(p, want) {
			t.Fatalf("消息缺 %q：\n%s", want, p)
		}
	}
	if strings.Count(p, "atrium task show t3") != 1 {
		t.Fatalf("任务详情命令未去重：\n%s", p)
	}
	t.Log("完整投递消息：\n" + p)
}
