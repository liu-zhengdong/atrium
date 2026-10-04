package quota

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
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
// 错误写明是哪个来源、缺或坏了哪个字段，不留笼统「损坏」。
func validateSources(rows []Pace) error {
	if len(rows) == 0 {
		return errors.New("OpenQuota 出口没有来源行，未接受部分结果")
	}
	if len(rows) > 64 {
		return fmt.Errorf("OpenQuota 来源 %d 行超过 64，未接受部分结果", len(rows))
	}
	seen := map[string]bool{}
	byReason := map[string][]string{}
	var reasons []string
	for _, p := range rows {
		why := sourceBadness(p, seen)
		if why == "" {
			continue
		}
		if _, ok := byReason[why]; !ok {
			reasons = append(reasons, why)
		}
		acct := p.Account
		if acct == "" {
			acct = "（缺 providerId）"
		}
		byReason[why] = append(byReason[why], acct)
	}
	if len(reasons) == 0 {
		return nil
	}
	var b strings.Builder
	b.WriteString("OpenQuota 来源 ")
	for i, why := range reasons {
		if i == 2 {
			b.WriteString("；……")
			break
		}
		if i > 0 {
			b.WriteString("；")
		}
		accts := byReason[why]
		b.WriteString(strings.Join(accts[:min(3, len(accts))], "、"))
		if len(accts) > 3 {
			fmt.Fprintf(&b, " 等 %d 行", len(accts))
		}
		b.WriteString(why)
	}
	b.WriteString("，未接受部分结果")
	return errors.New(b.String())
}

// sourceBadness 是一行来源的第一个拒收原因；通过为空。seen 跨行查 providerId 重复。
func sourceBadness(p Pace, seen map[string]bool) string {
	if p.Account == "" {
		return "缺 providerId"
	}
	if seen[p.Account] {
		return "providerId 重复"
	}
	seen[p.Account] = true
	switch {
	case p.Quotas == nil || p.ValueMetrics == nil:
		return "缺 quotas/valueMetrics 数组"
	case p.QuotaLimit != 64 || p.ValueMetricLimit != 64:
		return "quotaLimit/valueMetricLimit 不是 64"
	case p.QuotaCount != len(p.Quotas):
		return "quotaCount 与 quotas 长度不符"
	case p.ValueMetricCount != len(p.ValueMetrics):
		return "valueMetricCount 与 valueMetrics 长度不符"
	case len(p.Quotas) > 64 || len(p.ValueMetrics) > 64:
		return "窗口或指标超过 64"
	}
	switch p.CacheIdentityMatch {
	case "matched", "mismatched", "unknown":
	default:
		return "cacheIdentityMatch 值未知"
	}
	switch p.DataQuality {
	case "refreshFailed", "empty", "remembered", "stale", "live", "cache":
	default:
		return "dataQuality 值未知"
	}
	switch p.RefreshOutcome {
	case "notRequested", "live", "reused", "failed":
	default:
		return "refreshOutcome 值未知"
	}
	if p.AccountIdentity != nil && (p.AccountIdentity.Kind != "accountHash" || p.AccountIdentity.Value == "" || p.AccountIdentity.Source == "") {
		return "accountIdentity 缺 kind/value/source"
	}
	if p.CacheIdentityMatch == "matched" && p.AccountIdentity == nil {
		return "cacheIdentityMatch=matched 但缺 accountIdentity"
	}
	ids := map[string]bool{}
	for _, w := range p.Quotas {
		if w.ID == "" || ids[w.ID] {
			return "窗口缺 id 或重复"
		}
		ids[w.ID] = true
		if w.UsedPercent == nil || math.IsNaN(*w.UsedPercent) || math.IsInf(*w.UsedPercent, 0) || *w.UsedPercent < 0 || *w.UsedPercent > 100 {
			return "窗口 " + w.ID + " 的 usedPercent 缺失或越界"
		}
		switch w.Format {
		case "percent", "count", "dollars":
		default:
			return "窗口 " + w.ID + " 的 format 未知"
		}
		for _, v := range []*float64{w.UsedValue, w.LimitValue, w.RemainingValue} {
			if v != nil && (*v < 0 || math.IsNaN(*v) || math.IsInf(*v, 0)) {
				return "窗口 " + w.ID + " 的数值为负或无穷"
			}
		}
		if w.Unit != nil && *w.Unit == "" {
			return "窗口 " + w.ID + " 的 unit 为空串"
		}
	}
	if s := p.SharedScope; s != nil {
		if s.ID == "" || s.Source == "" || len(s.WindowIDs) == 0 {
			return "sharedScope 缺 id/source/windowIds"
		}
		for _, id := range s.WindowIDs {
			if !ids[id] {
				return "sharedScope 引用不存在的窗口 " + id
			}
		}
	}
	return ""
}
