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
	KnownCostUSD       *float64       `json:"known_cost_usd"`
	CostText           string         `json:"cost_text"`
	CostSamples        int            `json:"cost_samples"`
	CostPerDeliveryUSD *float64       `json:"cost_per_delivery_usd"`
}

// Qualities 纯聚合任务拉起与负责人唤醒（各自按组合分组，任务在前）；与 Recent 一样排除没有结果的拉起、合并强度；
// key 把当时的执行者标识规范成统计键（statKeys 的产物）。
func Qualities(tasks, wakes []Attempt, key func(string) string) []Quality {
	t, l := qualities(tasks, false, key), qualities(wakes, true, key)
	sortQualities(t)
	sortQualities(l)
	return append(t, l...)
}

func qualities(attempts []Attempt, leader bool, key func(string) string) []Quality {
	groups := map[string][]Attempt{}
	for _, a := range attempts {
		if a.Outcome != "" {
			k := key(a.Worker)
			groups[k] = append(groups[k], a)
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
			if v := a.Usage.InUSD(); v != nil && len(a.Usage.Missing) == 0 && *v >= 0 && !math.IsNaN(*v) && !math.IsInf(*v, 0) {
				q.CostSamples++
				total += *v
			}
		}
		if q.CostSamples > 0 {
			q.KnownCostUSD = &total
		}
		q.DeliveryRate = float64(q.OK) / float64(q.Launches)
		q.RetryRate = float64(q.Retries) / float64(q.Launches)
		if q.OK > 0 && q.CostSamples == q.Launches {
			v := total / float64(q.OK)
			q.CostPerDeliveryUSD = &v
		}
		q.CostText = q.costText()
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
	coverage := fmt.Sprintf("完整读数 %d/%d", q.CostSamples, q.Launches)
	if q.CostPerDeliveryUSD != nil {
		return fmt.Sprintf("每次交付 USD %.6g（%s）", *q.CostPerDeliveryUSD, coverage)
	}
	if q.KnownCostUSD != nil {
		return fmt.Sprintf("已知合计 USD %.6g（%s；每次交付未知）", *q.KnownCostUSD, coverage)
	}
	return fmt.Sprintf("未知（%s）", coverage)
}

func (q Quality) String() string {
	return fmt.Sprintf("近 %d 天 %d 次拉起：交付 %d（%.1f%%） · 被交回 %d · 重试 %d（%.1f%%） · 其他失败 %d · 额度 %d · 起不来 %d · 花费 %s · 用时中位 %s", int(QualityWindow.Hours()/24), q.Launches, q.OK, q.DeliveryRate*100, q.Bounce, q.Retries, q.RetryRate*100, q.Fail, q.Quota, q.Setup, q.costText(), DurationText(q.MedianMS))
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
