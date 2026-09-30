package workers

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// UsageMetric 每个类别分别统计有效读数；钱按货币、计费方式分组，绝不混加。
type UsageMetric struct {
	Name      string   `json:"name"`
	Currency  string   `json:"currency,omitempty"`
	Billing   string   `json:"billing,omitempty"`
	Samples   int      `json:"samples"`
	Total     float64  `json:"total"`
	Median    *float64 `json:"median"`
	Estimated int      `json:"estimated"`
}

func usageStats(ls []Attempt) []UsageMetric {
	var out []UsageMetric
	for _, name := range usageNames {
		out = append(out, UsageMetric{Name: name})
	}
	values := make([][]float64, 4)
	for _, a := range ls {
		for i, n := range []*int64{a.Usage.Input, a.Usage.Output, a.Usage.CacheRead, a.Usage.CacheWrite} {
			if n != nil {
				values[i] = append(values[i], float64(*n))
			}
		}
		u := a.Usage
		if u.Cost == nil {
			continue
		}
		i := 4
		for ; i < len(out); i++ {
			if out[i].Currency == u.Currency && out[i].Billing == u.Billing {
				break
			}
		}
		if i == len(out) {
			name := "花费"
			if u.Billing == "" {
				name = "金额"
			}
			if u.Billing == "subscription" {
				name = "折合"
			}
			out = append(out, UsageMetric{Name: name, Currency: u.Currency, Billing: u.Billing})
			values = append(values, nil)
		}
		values[i] = append(values[i], *u.Cost)
		if u.Source == "estimate" {
			out[i].Estimated++
		}
	}
	for i, v := range values {
		out[i].Samples = len(v)
		for _, n := range v {
			out[i].Total += n
		}
		if len(v) > 0 {
			slices.Sort(v)
			n := len(v) / 2
			m := v[n]
			if len(v)%2 == 0 {
				m = v[n-1] + (m-v[n-1])/2
			}
			out[i].Median = &m
		}
	}
	return out
}

func (s Stat) UsageText() string {
	if len(s.Usage) == 0 {
		return "token 与花费读不到"
	}
	var parts []string
	for _, m := range s.Usage {
		if m.Samples == 0 {
			parts = append(parts, m.Name+"：读不到")
			continue
		}
		note := ""
		if m.Estimated > 0 {
			note = fmt.Sprintf("，%d 次估算", m.Estimated)
		}
		if m.Currency != "" && m.Billing == "" {
			note += "，计费方式未设置"
		}
		currency := ""
		total, med := strconv.FormatFloat(m.Total, 'f', -1, 64), strconv.FormatFloat(*m.Median, 'f', -1, 64)
		if m.Currency != "" {
			currency = m.Currency + " "
			total, med = fmt.Sprintf("%.6g", m.Total), fmt.Sprintf("%.6g", *m.Median)
		}
		parts = append(parts, fmt.Sprintf("%s %s合计 %s / 每次中位 %s（%d/%d 次%s）", m.Name, currency, total, med, m.Samples, s.Launches, note))
	}
	return strings.Join(parts, " · ")
}
