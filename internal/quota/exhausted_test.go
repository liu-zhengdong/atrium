package quota

import (
	"testing"
	"time"
)

func TestExhaustedUntil(t *testing.T) {
	now := time.Date(2026, 10, 3, 10, 35, 0, 0, time.UTC)
	at := func(d time.Duration) *string { s := now.Add(d).Format(time.RFC3339Nano); return &s }
	win := func(used float64, reset *string) SourceWindow {
		return SourceWindow{ID: "weekly", UsedPercent: ptr(used), ResetsAt: reset}
	}
	row := func(account string, stale bool, ws ...SourceWindow) Pace {
		return Pace{Account: account, Stale: stale, SourceFacts: SourceFacts{Quotas: ws}}
	}
	cases := []struct {
		name string
		rows []Pace
		want time.Duration
	}{
		{"用满取重置时刻", []Pace{row("grok", false, win(100, at(16*time.Hour)))}, 16 * time.Hour},
		{"多个窗口用满取最晚", []Pace{row("grok", false, win(100, at(2*time.Hour)), win(100, at(30*time.Hour)))}, 30 * time.Hour},
		{"没用满不算", []Pace{row("grok", false, win(99.9, at(16*time.Hour)))}, 0},
		{"别的账号不算", []Pace{row("codex", false, win(100, at(16*time.Hour)))}, 0},
		{"陈旧读数不算", []Pace{row("grok", true, win(100, at(16*time.Hour)))}, 0},
		{"重置时刻已过不算", []Pace{row("grok", false, win(100, at(-time.Minute)))}, 0},
		{"没写重置时刻", []Pace{row("grok", false, win(100, nil))}, 0},
		{"坏时刻", []Pace{row("grok", false, win(100, func() *string { s := "明天"; return &s }()))}, 0},
	}
	for _, c := range cases {
		got := ExhaustedUntil(c.rows, "grok", now.UnixMilli())
		want := int64(0)
		if c.want != 0 {
			want = now.Add(c.want).UnixMilli()
		}
		if got != want {
			t.Errorf("%s：得 %d，期望 %d", c.name, got, want)
		}
	}
}
