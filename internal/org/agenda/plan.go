package agenda

import (
	"fmt"
	"regexp"
	"strconv"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
)

// 周期任务的时间判定：纯函数，表驱动测试。时刻是 Unix 毫秒；--at 按 loc 的本机钟点，跨夏令时仍是同一钟点。

const (
	minute   = int64(time.Minute / time.Millisecond)
	hour     = 60 * minute
	day      = 24 * hour
	everyMin = hour
	everyMax = 366 * day
)

var everyRe = regexp.MustCompile(`^([1-9][0-9]{0,5})([mhdw])$`)
var atRe = regexp.MustCompile(`^([0-9]{1,2}):([0-9]{2})$`)

// ParseEvery：7d、1d、12h、2w、90m；至少 1h、至多 366d。
func ParseEvery(s string) (int64, error) {
	m := everyRe.FindStringSubmatch(s)
	if m == nil {
		return 0, api.Usage("--every: 写成 7d、1d、12h、2w 这样，至少 1h、至多 366d")
	}
	n, _ := strconv.ParseInt(m[1], 10, 64)
	ms := n * map[string]int64{"m": minute, "h": hour, "d": day, "w": 7 * day}[m[2]]
	if ms < everyMin || ms > everyMax {
		return 0, api.Usage("--every: 至少 1h、至多 366d，收到 %s", s)
	}
	return ms, nil
}

// EveryText 是周期的写法（与 --every 同一套）。
func EveryText(ms int64) string {
	switch {
	case ms%day == 0:
		return fmt.Sprintf("%dd", ms/day)
	case ms%hour == 0:
		return fmt.Sprintf("%dh", ms/hour)
	}
	return fmt.Sprintf("%dm", ms/minute)
}

// ParseAt：--at HH:MM（本机钟点）→ 当天第几分钟；只有整天的周期能定钟点。
func ParseAt(s string, every int64) (int, error) {
	m := atRe.FindStringSubmatch(s)
	if m == nil {
		return 0, api.Usage("--at: 写成 09:30 这样的本机钟点")
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	if h > 23 || mi > 59 {
		return 0, api.Usage("--at: 写成 09:30 这样的本机钟点")
	}
	if every%day != 0 {
		return 0, api.Usage("--at: 只有整天的周期（如 --every 1d、7d）能定钟点")
	}
	return h*60 + mi, nil
}

func AtText(at int) string { return fmt.Sprintf("%02d:%02d", at/60, at%60) }

// Cadence 是给人看的周期：「每周三 09:00」「每 2 周 周三」「每天 09:00」「每 12 小时」；星期按下一轮在 loc 里算。
// 命令行与网页共用这一份。
func Cadence(x Schedule, loc *time.Location) string {
	clock := ""
	if x.At != "" {
		clock = " " + x.At
	}
	week := 7 * day
	switch ms := x.EveryMs; {
	case ms%week == 0:
		wd := "周" + string([]rune("日一二三四五六")[time.UnixMilli(x.NextAt).In(loc).Weekday()])
		if ms == week {
			return "每" + wd + clock
		}
		return fmt.Sprintf("每 %d 周 %s%s", ms/week, wd, clock)
	case ms == day:
		return "每天" + clock
	case ms%day == 0:
		return fmt.Sprintf("每 %d 天%s", ms/day, clock)
	case ms%hour == 0:
		return fmt.Sprintf("每 %d 小时", ms/hour)
	default:
		return fmt.Sprintf("每 %d 分钟", ms/minute)
	}
}

// clockOn 是 t 所在本机日期往后 days 天的 at 钟点。
func clockOn(t time.Time, days, at int, loc *time.Location) int64 {
	l := t.In(loc)
	return time.Date(l.Year(), l.Month(), l.Day()+days, at/60, at%60, 0, 0, loc).UnixMilli()
}

// FirstDue 是新建时的第一轮：没定钟点的一个周期后；定了钟点的是下一个到来的该钟点（今天没过就是今天）。
func FirstDue(now, every int64, at *int, loc *time.Location) int64 {
	if at == nil {
		return now + every
	}
	if t := clockOn(time.UnixMilli(now), 0, *at, loc); t > now {
		return t
	}
	return clockOn(time.UnixMilli(now), 1, *at, loc)
}

// Following 是一轮之后的下一轮；定了钟点的按本机日历加整天。
func Following(due, every int64, at *int, loc *time.Location) int64 {
	if at == nil {
		return due + every
	}
	return clockOn(time.UnixMilli(due), int(every/day), *at, loc)
}

// CatchUp：从 due 往后数，到 now 为止一共到了几轮（slots）、下一轮在什么时候。停机很久也是常数步。
func CatchUp(due, every int64, at *int, now int64, loc *time.Location) (slots int64, next int64) {
	if due > now {
		return 0, due
	}
	slots, next = 1, Following(due, every, at, loc)
	if jump := (now-next)/every - 1; jump > 0 {
		// 夏令时让一轮最多差一小时：先跳到 now 前一两轮，再逐轮走。
		if at == nil {
			next += jump * every
		} else {
			next = Following(next, jump*every, at, loc)
		}
		slots += jump
	}
	for next <= now {
		slots++
		next = Following(next, every, at, loc)
	}
	return slots, next
}

// Verdict 是巡检时一条周期任务该做什么。
type Verdict struct {
	Kind   string // wait 没到点；run 生成一轮；skip 上一轮没结束，本轮跳过
	Next   int64  // 下一轮
	Missed int64  // 停机错过、不再补的轮数
	Open   string // skip 时上一轮的任务
}

// Due：停机错过好几轮只补一轮；上一轮没结束（open 非空）就跳过。
func Due(nextAt, every int64, at *int, open string, now int64, loc *time.Location) Verdict {
	if nextAt > now {
		return Verdict{Kind: "wait", Next: nextAt}
	}
	slots, next := CatchUp(nextAt, every, at, now, loc)
	if open != "" {
		return Verdict{Kind: "skip", Next: next, Missed: slots - 1, Open: open}
	}
	return Verdict{Kind: "run", Next: next, Missed: slots - 1}
}

// OpenStatus：上一轮算没结束的状态。
func OpenStatus(s string) bool {
	return s == "todo" || s == "queued" || s == "running" || s == "blocked"
}
