package workers

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// Quality 是一个组合全部有结果的拉起；结果与用时口径复用 Count。
// Leader 为真的是负责人唤醒：一次唤醒算一次拉起，与任务拉起口径不同，分开成行。
type Quality struct {
	Stat
	Combo              string         `json:"combo"`
	Leader             bool           `json:"leader"`
	DeliveryRate       float64        `json:"delivery_rate"`
	Retries            int            `json:"retries"`
	RetryRate          float64        `json:"retry_rate"`
	BounceReasons      map[string]int `json:"bounce_reasons"`
	CostSamples        int            `json:"cost_samples"`
	CostPerDeliveryUSD *float64       `json:"cost_per_delivery_usd"`
}

// Qualities 纯聚合任务拉起与负责人唤醒（各自按组合分组，任务在前）；与 Recent 一样排除没有结果的拉起、合并强度。
func Qualities(tasks, wakes []Attempt) []Quality {
	t, l := qualities(tasks, false), qualities(wakes, true)
	sortQualities(t)
	sortQualities(l)
	return append(t, l...)
}

func qualities(attempts []Attempt, leader bool) []Quality {
	groups := map[string][]Attempt{}
	for _, a := range attempts {
		if a.Outcome != "" {
			groups[Combo(a.Worker)] = append(groups[Combo(a.Worker)], a)
		}
	}
	out := []Quality{}
	for combo, ls := range groups {
		q := Quality{Stat: Count(ls), Combo: combo, Leader: leader, BounceReasons: map[string]int{}}
		total := 0.0
		for _, a := range ls {
			if a.N > 1 {
				q.Retries++
			}
			if a.Outcome == OutBounce {
				q.BounceReasons[a.Reason]++
			}
			u := a.Usage
			if u.Cost != nil && u.Currency == "USD" && len(u.Missing) == 0 && *u.Cost >= 0 && !math.IsNaN(*u.Cost) && !math.IsInf(*u.Cost, 0) {
				q.CostSamples++
				total += *u.Cost
			}
		}
		q.DeliveryRate = float64(q.OK) / float64(q.Launches)
		q.RetryRate = float64(q.Retries) / float64(q.Launches)
		if q.OK > 0 && q.CostSamples == q.Launches {
			v := total / float64(q.OK)
			q.CostPerDeliveryUSD = &v
		}
		out = append(out, q)
	}
	return out
}

func sortQualities(out []Quality) {
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.DeliveryRate != b.DeliveryRate {
			return a.DeliveryRate > b.DeliveryRate
		}
		ac, bc := math.Inf(1), math.Inf(1)
		if a.CostPerDeliveryUSD != nil {
			ac = *a.CostPerDeliveryUSD
		}
		if b.CostPerDeliveryUSD != nil {
			bc = *b.CostPerDeliveryUSD
		}
		if ac != bc {
			return ac < bc
		}
		if a.MedianMS == nil || b.MedianMS == nil {
			if (a.MedianMS == nil) != (b.MedianMS == nil) {
				return a.MedianMS != nil
			}
		} else if *a.MedianMS != *b.MedianMS {
			return *a.MedianMS < *b.MedianMS
		}
		return a.Combo < b.Combo
	})
}

// Name 是表里这一行的名字：负责人唤醒在组合后标「（负责人）」。
func (q Quality) Name() string {
	if q.Leader {
		return q.Combo + "（负责人）"
	}
	return q.Combo
}

func (q Quality) costText() string {
	if q.CostPerDeliveryUSD == nil {
		return fmt.Sprintf("未知（USD 完整读数 %d/%d）", q.CostSamples, q.Launches)
	}
	return fmt.Sprintf("USD %.6g", *q.CostPerDeliveryUSD)
}

func (q Quality) String() string {
	return fmt.Sprintf("全量 %d 次拉起：交付 %d（%.1f%%） · 被交回 %d · 重试 %d（%.1f%%） · 其他失败 %d · 额度 %d · 起不来 %d · 每次交付 %s · 用时中位 %s", q.Launches, q.OK, q.DeliveryRate*100, q.Bounce, q.Retries, q.RetryRate*100, q.Fail, q.Quota, q.Setup, q.costText(), DurationText(q.MedianMS))
}

func writeBounceReasons(b *strings.Builder, q Quality) {
	keys := make([]string, 0, len(q.BounceReasons))
	for k := range q.BounceReasons {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		label := k
		if label == "" {
			label = "未记录原因"
		}
		fmt.Fprintf(b, "  交回原因 %d 次：%s\n", q.BounceReasons[k], oneLine(label))
	}
}
