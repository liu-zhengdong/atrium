package workers

import (
	"fmt"
	"slices"
)

func elapsed(start, end int64) *int64 {
	if start <= 0 || end < start {
		return nil
	}
	d := end - start
	return &d
}

// median 不改输入；偶数个样本取中间两个的均值（毫秒）。
func median(values []int64) *int64 {
	if len(values) == 0 {
		return nil
	}
	v := slices.Clone(values)
	slices.Sort(v)
	n := len(v) / 2
	m := v[n]
	if len(v)%2 == 0 {
		m = v[n-1] + (v[n]-v[n-1])/2
	}
	return &m
}

// DurationText 用相同精度展示用时；没有样本不编数。
func DurationText(ms *int64) string {
	if ms == nil {
		return "—"
	}
	if *ms < 60_000 {
		return fmt.Sprintf("%d 秒", *ms/1000)
	}
	return fmt.Sprintf("%d 分", *ms/60_000)
}

// Timing 是三个统计入口共用的用时文案。
func (s Stat) Timing() string {
	return "用时中位 " + DurationText(s.MedianMS) + " · 最长 " + DurationText(s.MaxMS)
}
