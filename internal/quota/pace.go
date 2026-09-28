package quota

import (
	"math"
	"strings"
	"time"
)

// 纯函数：把窗口折成与 `openquota pace --json` 同口径的一行（照 OpenQuota 的 cli.rs build_row、pacing.rs）。
// - 对比窗口：名字含 week 的里最长的；没有就所有窗口里最长的；
// - 短窗：名字含 session 的；没有就 6 小时以内最短的；
// - 周期进度只在用量有意义时给，富余随之留空。

const staleAfter = 10 * 60_000 // 超过 10 分钟的读数算旧数

func clampPct(v float64) float64 { return min(100, max(0, v)) }

// round1 保留一位小数（远离零取整）。
func round1(v float64) float64 { return math.Copysign(math.Round(math.Abs(v)*10), v)/10 + 0 }

func named(w Window, needle string) bool {
	return strings.Contains(strings.ToLower(w.ID), needle) || strings.Contains(strings.ToLower(w.Label), needle)
}

func longest(ws []Window) *Window {
	var best *Window
	for i := range ws {
		if best == nil || ws[i].Period > best.Period {
			best = &ws[i]
		}
	}
	return best
}

func comparisonWindow(ws []Window) *Window {
	var weekly []Window
	for _, w := range ws {
		if named(w, "week") {
			weekly = append(weekly, w)
		}
	}
	if len(weekly) > 0 {
		return longest(weekly)
	}
	return longest(ws)
}

func shortWindow(ws []Window) *Window {
	for i := range ws {
		if named(ws[i], "session") {
			return &ws[i]
		}
	}
	var best *Window
	for i := range ws {
		if ws[i].Period > 0 && ws[i].Period <= 6*hour && (best == nil || ws[i].Period < best.Period) {
			best = &ws[i]
		}
	}
	return best
}

// elapsedPercent 是周期已过去的百分比；用量信号不足时为 nil。
func elapsedPercent(w Window, now int64) *float64 {
	used := clampPct(w.Used)
	if math.Round(100-used) <= 0 || used <= 0 || w.ResetsAt == 0 || w.Period == 0 || w.ResetsAt <= now {
		return nil
	}
	start := w.ResetsAt - w.Period*1000
	elapsed := float64(max(0, now-start)) / 1000
	progress := min(1, max(0, elapsed/float64(w.Period)))
	if elapsed < max(float64(w.Period)*0.01, 60) {
		return nil
	}
	if used/progress > 90 && used < 5 {
		return nil
	}
	p := progress * 100
	return &p
}

func ptr(v float64) *float64 { return &v }

// PaceOf 把一份读数折成一行。
func PaceOf(r Reading, now int64) Pace {
	p := Pace{Account: r.Account, Plan: r.Plan,
		RefreshedAt:   time.UnixMilli(r.ReadAt / 1000 * 1000).UTC().Format(time.RFC3339),
		RefreshedAgoH: round1(float64(max(0, (now-r.ReadAt)/1000)) / 3600),
		Stale:         now-r.ReadAt >= staleAfter,
	}
	if c := comparisonWindow(r.Windows); c != nil {
		p.UsedPercent = ptr(round1(clampPct(c.Used)))
		if e := elapsedPercent(*c, now); e != nil {
			p.ElapsedPct = ptr(round1(*e))
			p.SparePercent = ptr(round1(*e - clampPct(c.Used)))
		}
		if c.ResetsAt != 0 {
			p.HoursToReset = ptr(round1(float64((c.ResetsAt-now)/1000) / 3600))
		}
	}
	if s := shortWindow(r.Windows); s != nil {
		p.ShortUsedPct = ptr(round1(clampPct(s.Used)))
	}
	return p
}
