package workers

import (
	"context"

	"github.com/liu-zhengdong/atrium/internal/app"
	"math"
	"slices"
	"time"

	"github.com/liu-zhengdong/atrium/internal/quota"
)

// ResolveExecution 是 workers/hosts 实际解析与启动事实的注入入口。
// 当前来源不证明执行凭据/模型成员，默认保留未知；不解析个人配置或推导
// provider 别名。绑定提供者每次返回独立的不可变值，随本轮解析失效。
var ResolveExecution = func(_ context.Context, _ *app.Env, r Resolved, _ string) (Resolved, error) { return r, nil }

// ExecutionBinding 是实际组合/机器与来源的本轮解析证据；Provider 是实际
// provider，Card 是来源卡片，Account 不使用凭据 Finger。Source 说明凭据
// 来源与模型成员依据。窗口仅限已证实作用于本组合的范围，不按 provider 扩展。
// 生命周期随本轮解析/进程结束；不存档案、数据库或日志。真实来源缺失时 nil。
type ExecutionBinding struct {
	Worker, Host, Provider, Card, Source string
	Account                              quota.AccountIdentity
	Scope                                *quota.SharedScope
	WindowIDs                            []string
}

func (b *ExecutionBinding) Valid(r Resolved, host string) bool {
	if b == nil || b.Worker != r.ID || b.Host != host || b.Provider == "" || b.Card == "" || b.Source == "" || b.Account.Kind != "accountHash" || b.Account.Value == "" || b.Account.Source == "" || len(b.WindowIDs) == 0 || len(b.WindowIDs) > 64 {
		return false
	}
	for i, id := range b.WindowIDs {
		if id == "" || slices.Contains(b.WindowIDs[:i], id) {
			return false
		}
	}
	if b.Scope != nil {
		if b.Scope.ID == "" || b.Scope.Source == "" || len(b.Scope.WindowIDs) == 0 || len(b.Scope.WindowIDs) > 64 {
			return false
		}
		for _, id := range b.Scope.WindowIDs {
			if !slices.Contains(b.WindowIDs, id) {
				return false
			}
		}
	}
	return true
}

// SamePool 要求来源边界、账号、实际 provider、池及作用窗口均相同。
// 同账号、同 key、同套餐名或同 provider 均不能独立证明共享。
func SamePool(a, b *ExecutionBinding) bool {
	if a == nil || b == nil || a.Source == "" || b.Source == "" || a.Provider != b.Provider ||
		a.Account != b.Account || a.Account.Value == "" || a.Account.Source == "" ||
		a.Scope == nil || b.Scope == nil || a.Scope.ID == "" || a.Scope.Source == "" ||
		a.Scope.ID != b.Scope.ID || a.Scope.Source != b.Scope.Source {
		return false
	}
	for _, id := range a.Scope.WindowIDs {
		if slices.Contains(a.WindowIDs, id) && slices.Contains(b.Scope.WindowIDs, id) && slices.Contains(b.WindowIDs, id) {
			return true
		}
	}
	return false
}

func (a Availability) checkBinding(r Resolved, host string, tokens int64) (quota.Spare, string) {
	sp := quota.Spare{}
	b := r.QuotaBinding
	if !b.Valid(r, host) || host != quota.LocalHost {
		return sp, ""
	}
	for _, p := range a.Sources {
		if p.Account != b.Card || p.AccountIdentity == nil || *p.AccountIdentity != b.Account ||
			p.CacheIdentityMatch != "matched" || p.Stale || p.Remembered || p.ErrorKind != nil ||
			p.RefreshOutcome == "failed" || (p.DataQuality != "live" && p.DataQuality != "cache") {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, p.RefreshedAt)
		if err != nil || at.UnixMilli() > a.Now || a.Now-at.UnixMilli() >= int64(10*time.Minute/time.Millisecond) {
			continue
		}
		if b.Scope != nil && (p.SharedScope == nil || b.Scope.ID != p.SharedScope.ID || b.Scope.Source != p.SharedScope.Source || !slices.Equal(b.Scope.WindowIDs, p.SharedScope.WindowIDs)) {
			continue
		}
		// 缺一条绑定窗口时整组未知，不能用剩下的周窗掩盖月窗。
		windows := make([]quota.SourceWindow, 0, len(b.WindowIDs))
		for _, id := range b.WindowIDs {
			found := false
			for _, w := range p.Quotas {
				if w.ID == id {
					windows = append(windows, w)
					found = true
					break
				}
			}
			if !found {
				return quota.Spare{}, ""
			}
		}
		sp.Account = p.Account
		for _, w := range windows {
			if w.ResetsAt != nil {
				reset, err := time.Parse(time.RFC3339Nano, *w.ResetsAt)
				if err != nil || reset.UnixMilli() <= a.Now {
					return quota.Spare{}, ""
				}
			}
			// 周期富余沿用 SpareOf，但只喂本窗口的原百分比，不喂摘要 sparePercent。
			line := quota.Line{Account: p.Account, UsedPercent: w.UsedPercent}
			if w.PeriodSeconds > 0 && w.ResetsAt != nil {
				reset, _ := time.Parse(time.RFC3339Nano, *w.ResetsAt)
				elapsed := 100 - float64(reset.UnixMilli()-a.Now)/(float64(w.PeriodSeconds)*1000)*100
				if elapsed >= 0 && elapsed <= 100 && w.UsedPercent != nil {
					spare := elapsed - *w.UsedPercent
					line.ElapsedPct = &elapsed
					line.SparePercent = &spare
				}
			}
			s := quota.SpareOf(line, a.Reserve)
			if s.Stop != "" {
				sp.Stop = s.Stop + "（" + w.ID + "）"
			}
			if s.Percent != nil && (sp.Percent == nil || *s.Percent < *sp.Percent) {
				sp.Percent = s.Percent
			}
			if c := tokenWindow(w, a.Reserve); c != nil {
				sp.TokenWindows = append(sp.TokenWindows, *c)

			}
		}
		return sp.WithDemand(tokens), ""
	}
	return sp, ""
}

func tokenWindow(w quota.SourceWindow, reserve int) *quota.TokenWindow {
	if w.Unit == nil || *w.Unit != "tokens" || w.Estimated || w.SourceNote == nil || *w.SourceNote == "" || w.LimitValue == nil || w.UsedValue == nil {
		return nil
	}
	total, used := *w.LimitValue, *w.UsedValue
	if total < 0 || used < 0 || used > total || math.IsNaN(total) || math.IsNaN(used) || math.IsInf(total, 0) || math.IsInf(used, 0) {
		return nil
	}
	remaining := total - used
	if w.RemainingValue != nil {
		if *w.RemainingValue < 0 || *w.RemainingValue > remaining || math.IsNaN(*w.RemainingValue) || math.IsInf(*w.RemainingValue, 0) {
			return nil
		}
		remaining = *w.RemainingValue
	}
	return &quota.TokenWindow{ID: w.ID, Total: total, Used: used, Remaining: remaining, Available: math.Max(0, remaining-total*float64(reserve)/100)}
}
