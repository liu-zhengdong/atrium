package workers

import (
	"context"
	"errors"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// QuotaAccount 对应已有额度读取器的套餐范围。Go 的模型共享套餐；其他
// provider、自定义端点不冒充 Go，也不把 API 账号等同于 CLI 的订阅账号。
func QuotaAccount(s Spec) string {
	provider, _, qualified := strings.Cut(s.Model, "/")
	if (s.Tool == "pi" || s.Tool == "opencode") && qualified {
		if provider == "opencode-go" {
			return "opencode"
		}
		return s.Tool + "+" + provider
	}
	if s.Tool == "agy" {
		return "antigravity"
	}
	return s.Tool
}

func sharedQuota(s Spec) bool {
	if s.Tool == "claude" || s.Tool == "codex" {
		return true
	}
	return (s.Tool == "pi" || s.Tool == "opencode") && strings.HasPrefix(s.Model, "opencode-go/")
}

// Availability 是一次选择用的缓存快照，不读取登录、钥匙串或云端。
// t865 可在 Launcher 注入侧复用 LoadAvailability/Check，org 无需依赖 workers。
type Availability struct {
	Readings   []quota.Stored
	Marks      []Mark
	Local      map[string]quota.Spare
	Reserve    int
	Now        int64
	markScopes map[string]Spec
}

func LoadAvailability(ctx context.Context, env *app.Env) (Availability, error) {
	a := Availability{Now: store.Now(), Local: map[string]quota.Spare{}}
	var err error
	a.Readings, err = quota.Cached(ctx, env.DB)
	if err != nil {
		return a, err
	}
	a.Marks, err = Marks(ctx, env.DB, a.Now)
	if err != nil {
		return a, err
	}
	a.markScopes = map[string]Spec{}
	for _, m := range a.Marks {
		if m.Kind != SignalQuota {
			continue
		}
		r, err := Resolve(ctx, env.DB, Spec{Tool: m.Tool, Model: m.Model}.String())
		if err != nil {
			var problem *api.Error
			if !errors.As(err, &problem) {
				return a, err
			}
			continue // 已删除或无法解析的档案只保留原标记范围。
		}
		if r.Rules.Endpoint == "" && r.Rules.EndpointKey == "" {
			a.markScopes[m.Target()] = r.quotaSpec()
		}
	}
	ov, err := quota.Last(ctx, env)
	if err != nil {
		return a, err
	}
	a.Reserve = ov.Reserve
	// OpenQuota 的汇总没有机器/指纹，只能用于本机，不能封住其他机器的账号。
	for _, l := range ov.Lines {
		if l.Source == "openquota" {
			a.Local[l.Account] = quota.SpareOf(l, a.Reserve)
		}
	}
	return a, nil
}

// CheckResolved 自定义端点/另行注入的账号没有与 CLI 登录对应的证据，
// 只沿用该组合的标记，不使用 CLI 订阅额度或扩大套餐故障范围。
func (a Availability) CheckResolved(r Resolved, host string) (quota.Spare, string) {
	if r.Rules.Endpoint != "" || r.Rules.EndpointKey != "" {
		sp := quota.Spare{Account: r.ID}
		if m, ok := Blocked(a.Marks, r.Spec.Tool, r.Spec.Model, host); ok {
			return sp, m.Text()
		}
		return sp, ""
	}
	return a.check(r.Spec, r.quotaSpec(), host)
}

// QuotaMarked 标记额度失败的组合由账号/机器判定可用性，不能用全局
// tried 名单连坐另一账号；恢复轮数仍由 dispatch 的同一上限约束。
func (a Availability) QuotaMarked(s Spec) bool {
	for _, m := range a.Marks {
		if m.Kind == SignalQuota && (m.Until == 0 || m.Until > a.Now) && m.Covers(s) {
			return true
		}
	}
	return false
}

func (a Availability) reading(account, host string) *quota.Stored {
	var latest *quota.Stored
	for i := range a.Readings {
		r := &a.Readings[i]
		if r.Account == account && r.Host == host && r.OK &&
			a.Now-r.ReadAt <= 6*60*60*1000 && (latest == nil || r.ReadAt > latest.ReadAt) {
			latest = r
		}
	}
	return latest
}

// Check 纯判定：原有工具/模型标记、同套餐额度标记、SpareOf/Reserve 共用。
// 不同机器只在缓存有相同非空账号指纹与套餐名时共享额度故障。
// 没有账号关系证据不扩大标记；缺读数保留未知。
func (a Availability) Check(s Spec, host string) (quota.Spare, string) {
	return a.check(s, s, host)
}

func (a Availability) check(s, scope Spec, host string) (quota.Spare, string) {
	account := QuotaAccount(scope)
	sp := quota.Spare{Account: account}
	r := a.reading(account, host)
	if r != nil {
		sp = a.spare(scope, r.Reading)
	} else if host == quota.LocalHost {
		if local, ok := a.Local[account]; ok {
			sp = local
		}
	}
	for _, m := range a.Marks {
		if m.Until > 0 && m.Until <= a.Now {
			continue
		}
		if m.Host == host && m.Covers(s) && (m.Kind != SignalQuota || m.Model != "" || a.sharesMark(Spec{Tool: m.Tool, Model: m.Model}, scope, m.Host)) {
			return sp, m.Text()
		}
		source := Spec{Tool: m.Tool, Model: m.Model}
		if a.markScopes != nil {
			known, ok := a.markScopes[m.Target()]
			if !ok {
				continue
			}
			source = known
		}
		if m.Kind != SignalQuota || !a.sharesMark(source, scope, m.Host) || QuotaAccount(source) != account {
			continue
		}
		if m.Host == host {
			return sp, m.Text()
		}
		other := a.reading(account, m.Host)
		if r != nil && other != nil && r.Finger != "" && r.Finger == other.Finger && r.Plan == other.Plan {
			return sp, m.Text()
		}
	}
	return sp, sp.Stop
}
