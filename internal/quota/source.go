package quota

import (
	"encoding/json"
	"errors"
	"math"
)

// SourceFacts 对应 m146 的实际 pace 契约，随既有缓存刷新替换。
// 卡片标识、账号 hash 和共享范围分别保留；不与凭据 Finger 匹配。
type SourceFacts struct {
	WindowID           *string           `json:"windowId"`
	WindowLabel        *string           `json:"windowLabel"`
	ShortWindowID      *string           `json:"shortWindowId"`
	Quotas             []SourceWindow    `json:"quotas"`
	ValueMetrics       []json.RawMessage `json:"valueMetrics"`
	StatusMetrics      []json.RawMessage `json:"statusMetrics"`
	Notices            []json.RawMessage `json:"notices"`
	Warnings           []json.RawMessage `json:"warnings"`
	AccountIdentity    *AccountIdentity  `json:"accountIdentity"`
	SharedScope        *SharedScope      `json:"sharedScope"`
	Remembered         bool              `json:"remembered"`
	LastAttemptAt      *string           `json:"lastAttemptAt"`
	ErrorKind          *string           `json:"errorKind"`
	CacheIdentityMatch string            `json:"cacheIdentityMatch"`
	RefreshOutcome     string            `json:"refreshOutcome"`
	DataQuality        string            `json:"dataQuality"`
	QuotaCount         int               `json:"quotaCount"`
	QuotaLimit         int               `json:"quotaLimit"`
	ValueMetricCount   int               `json:"valueMetricCount"`
	ValueMetricLimit   int               `json:"valueMetricLimit"`
}

type AccountIdentity struct {
	Kind   string `json:"kind"`
	Value  string `json:"value"`
	Source string `json:"source"`
}

// SharedScope 不包含模型成员；不能据此扩成全部 provider/model。
type SharedScope struct {
	ID        string   `json:"id"`
	Source    string   `json:"source"`
	WindowIDs []string `json:"windowIds"`
}

type SourceWindow struct {
	ID             string   `json:"id"`
	Label          string   `json:"label"`
	UsedPercent    *float64 `json:"usedPercent"`
	ResetsAt       *string  `json:"resetsAt"`
	PeriodSeconds  uint64   `json:"periodSeconds"`
	Format         string   `json:"format"`
	UsedValue      *float64 `json:"usedValue"`
	LimitValue     *float64 `json:"limitValue"`
	RemainingValue *float64 `json:"remainingValue"`
	Unit           *string  `json:"unit"`
	Estimated      bool     `json:"estimated"`
	SourceNote     *string  `json:"sourceNote"`
}

// validateSources 拒绝损坏/超限的完整出口；不对旧缓存补造身份或字段。
func validateSources(rows []Pace) error {
	bad := func() error { return errors.New("OpenQuota 来源字段损坏或超限，未接受部分结果") }
	if len(rows) == 0 || len(rows) > 64 {
		return bad()
	}
	seen := map[string]bool{}
	for _, p := range rows {
		if p.Account == "" || seen[p.Account] {
			return bad()
		}
		seen[p.Account] = true
		if p.Quotas == nil || p.ValueMetrics == nil || p.QuotaLimit != 64 || p.ValueMetricLimit != 64 ||
			p.QuotaCount != len(p.Quotas) || p.ValueMetricCount != len(p.ValueMetrics) || len(p.Quotas) > 64 || len(p.ValueMetrics) > 64 {
			return bad()
		}
		if p.CacheIdentityMatch != "matched" && p.CacheIdentityMatch != "mismatched" && p.CacheIdentityMatch != "unknown" {
			return bad()
		}
		switch p.DataQuality {
		case "refreshFailed", "empty", "remembered", "stale", "live", "cache":
		default:
			return bad()
		}
		switch p.RefreshOutcome {
		case "notRequested", "live", "reused", "failed":
		default:
			return bad()
		}
		if p.AccountIdentity != nil && (p.AccountIdentity.Kind != "accountHash" || p.AccountIdentity.Value == "" || p.AccountIdentity.Source == "") {
			return bad()
		}
		if p.CacheIdentityMatch == "matched" && p.AccountIdentity == nil {
			return bad()
		}
		ids := map[string]bool{}
		for _, w := range p.Quotas {
			if w.ID == "" || ids[w.ID] || w.UsedPercent == nil || math.IsNaN(*w.UsedPercent) || math.IsInf(*w.UsedPercent, 0) || *w.UsedPercent < 0 || *w.UsedPercent > 100 {
				return bad()
			}
			ids[w.ID] = true
			switch w.Format {
			case "percent", "count", "dollars":
			default:
				return bad()
			}
			for _, v := range []*float64{w.UsedValue, w.LimitValue, w.RemainingValue} {
				if v != nil && (*v < 0 || math.IsNaN(*v) || math.IsInf(*v, 0)) {
					return bad()
				}
			}
			if w.Unit != nil && *w.Unit == "" {
				return bad()
			}
		}
		if s := p.SharedScope; s != nil {
			if s.ID == "" || s.Source == "" || len(s.WindowIDs) == 0 {
				return bad()
			}
			for _, id := range s.WindowIDs {
				if !ids[id] {
					return bad()
				}
			}
		}
	}
	return nil
}
