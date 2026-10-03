package workers

import "math"

// CompletePrices 只接受档案明确声明的四类单价；缺价不是免费。
// 不从 provider 名称、模型名或历史零金额推断当前价格。
func CompletePrices(r Rules) bool {
	if r.Prices == nil || r.Prices.Currency == "" {
		return false
	}
	for _, p := range priceParts(r.Prices) {
		if p == nil || *p < 0 || math.IsNaN(*p) || math.IsInf(*p, 0) {
			return false
		}
	}
	return true
}

func priceParts(p *Prices) []*float64 {
	return []*float64{p.Input, p.Output, p.CacheRead, p.CacheWrite}
}

func FreePrices(r Rules) bool {
	if !CompletePrices(r) || (r.Billing != "subscription" && r.Billing != "metered") {
		return false
	}
	for _, p := range priceParts(r.Prices) {
		if *p != 0 {
			return false
		}
	}
	return true
}

// Cheaper 只在已声明免费或订阅价格之间比较；同币种的每一项都不贵、
// 至少一项便宜才调序。不猜 token 比例、不换算货币、不把按量付费加入恢复。
func Cheaper(a, b Rules) bool {
	if !CompletePrices(a) || !CompletePrices(b) {
		return false
	}
	if !FreePrices(a) && a.Billing != "subscription" || !FreePrices(b) && b.Billing != "subscription" {
		return false
	}
	if FreePrices(a) != FreePrices(b) {
		return FreePrices(a)
	}
	if a.Prices.Currency != b.Prices.Currency {
		return false
	}
	less := false
	for i, p := range priceParts(a.Prices) {
		q := priceParts(b.Prices)[i]
		if *p > *q {
			return false
		}
		less = less || *p < *q
	}
	return less
}
