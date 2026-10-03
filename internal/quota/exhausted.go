package quota

import "time"

// ExhaustedUntil 给已经报了额度用尽、报文却没写恢复时刻的账号找恢复时刻（纯函数，毫秒）：
// 取这个来源类别非陈旧读数里已用满（≥100%）的窗口，最晚的那个重置时刻；读不出返回 0。
// 只用于本机来源：远程机器没有 pace 上报契约，不把本机读数移给别的机器。
func ExhaustedUntil(rows []Pace, account string, now int64) int64 {
	var until int64
	for _, p := range rows {
		if p.Account != account || p.Stale {
			continue
		}
		for _, w := range p.Quotas {
			if w.UsedPercent == nil || *w.UsedPercent < 100 || w.ResetsAt == nil {
				continue
			}
			t, err := time.Parse(time.RFC3339Nano, *w.ResetsAt)
			if err != nil || t.UnixMilli() <= now {
				continue
			}
			until = max(until, t.UnixMilli())
		}
	}
	return until
}
