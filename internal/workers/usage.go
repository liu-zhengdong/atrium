package workers

import (
	"fmt"
	"math"
	"strings"
)

// Tokens 按计费类别记录工具读数；nil 表示读不到，输入不包含缓存读写。
type Tokens struct {
	Input      *int64 `json:"input" yaml:"-"`
	Output     *int64 `json:"output" yaml:"-"`
	CacheRead  *int64 `json:"cache_read" yaml:"-"`
	CacheWrite *int64 `json:"cache_write" yaml:"-"`
}

// Prices 是每百万 token 的单价；缺价不能当成免费。
// USDRate 是 1 单位该货币折合多少 USD（只给非 USD 货币写），结算时折出的 USD 随每次拉起保存，改汇率不动历史。
type Prices struct {
	Currency   string   `json:"currency" yaml:"currency"`
	USDRate    *float64 `json:"usd_rate,omitempty" yaml:"usd_rate,omitempty"`
	Input      *float64 `json:"input" yaml:"input"`
	Output     *float64 `json:"output" yaml:"output"`
	CacheRead  *float64 `json:"cache_read" yaml:"cache_read"`
	CacheWrite *float64 `json:"cache_write" yaml:"cache_write"`
}

// Usage 是每次拉起的用量与计算结果，不保存档案单价。
type Usage struct {
	Tokens
	Cost     *float64 `json:"cost"`
	Currency string   `json:"currency,omitempty"`
	USD      *float64 `json:"usd,omitempty"`     // 非 USD 花费按结算时的 prices.usd_rate 折成的 USD；USD 花费不另存
	Source   string   `json:"source,omitempty"`  // tool / estimate
	Billing  string   `json:"billing,omitempty"` // metered / subscription
	Missing  []string `json:"missing,omitempty"` // 估算没算进的类别（读不到 token 或缺单价）
}

// InUSD 是这次花费的 USD 金额：USD 花费就是 Cost，其他货币用结算时折好的 USD；折不了返回 nil。
func (u Usage) InUSD() *float64 {
	if u.Cost == nil {
		return nil
	}
	if u.Currency == "USD" {
		return u.Cost
	}
	return u.USD
}

func (r Rules) billingProblems() []string {
	var out []string
	if r.Billing != "" && r.Billing != "metered" && r.Billing != "subscription" {
		out = append(out, "billing 只能是 metered（按量）或 subscription（订阅）")
	}
	if p := r.Prices; p != nil {
		if len(p.Currency) != 3 || strings.ToUpper(p.Currency) != p.Currency || strings.Trim(p.Currency, "ABCDEFGHIJKLMNOPQRSTUVWXYZ") != "" {
			out = append(out, "prices.currency 须是三位大写货币代码")
		}
		for _, v := range []*float64{p.Input, p.Output, p.CacheRead, p.CacheWrite} {
			if v != nil && (*v < 0 || math.IsNaN(*v) || math.IsInf(*v, 0)) {
				out = append(out, "prices 单价须是有限的非负数")
				break
			}
		}
		if v := p.USDRate; v != nil {
			switch {
			case p.Currency == "USD":
				out = append(out, "prices.usd_rate 只给非 USD 货币写，USD 不用折合")
			case !(*v > 0) || math.IsInf(*v, 0):
				out = append(out, "prices.usd_rate 须是有限的正数（1 单位该货币折合多少 USD）")
			}
		}
	}
	return out
}

// Charge 优先保留工具非零花费；否则按档案单价估算能算的类别，读不到 token 或缺单价的记进 Missing。
// token 与单价都没有的类别视为这个执行者没有，不算缺；一个类别都算不进就不估算。
// 非 USD 花费的货币与档案 prices 同币种且写了 usd_rate 时，按此刻的汇率折出 USD 一并保存。
func Charge(u Usage, r Rules) Usage {
	u = charge(u, r)
	u.USD = nil
	if p := r.Prices; u.Cost != nil && u.Currency != "USD" && p != nil && p.Currency == u.Currency && p.USDRate != nil {
		v := *u.Cost * *p.USDRate
		u.USD = &v
	}
	return u
}

func charge(u Usage, r Rules) Usage {
	u.Billing = r.Billing
	u.Missing = nil
	if u.Cost != nil && *u.Cost > 0 {
		u.Source = "tool"
		return u
	}
	u.Cost, u.Source, u.Currency = nil, "", ""
	if r.Prices == nil {
		return u
	}
	p := r.Prices
	cost, counted := 0.0, 0
	var missing []string
	for i, n := range []*int64{u.Input, u.Output, u.CacheRead, u.CacheWrite} {
		price := []*float64{p.Input, p.Output, p.CacheRead, p.CacheWrite}[i]
		switch {
		case n == nil && price == nil:
		case n == nil || (*n != 0 && price == nil):
			missing = append(missing, usageNames[i])
		default:
			counted++
			if price != nil {
				cost += float64(*n) * *price / 1e6
			}
		}
	}
	if counted == 0 {
		return u
	}
	u.Cost, u.Currency, u.Source, u.Missing = &cost, p.Currency, "estimate", missing
	return u
}

// usageNames 是四个 token 类别的叫法，顺序同 Tokens。
var usageNames = []string{"输入", "输出", "缓存读", "缓存写"}

func tokenText(n *int64) string {
	if n == nil {
		return "读不到"
	}
	return fmt.Sprint(*n)
}

func (u Usage) String() string {
	s := fmt.Sprintf("token 输入 %s / 输出 %s / 缓存读 %s / 写 %s", tokenText(u.Input), tokenText(u.Output), tokenText(u.CacheRead), tokenText(u.CacheWrite))
	label := "花费"
	if u.Billing == "subscription" {
		label = "折合"
	}
	if u.Cost == nil {
		return s
	}
	source := "工具报"
	if u.Source == "estimate" {
		source = "估算"
		if len(u.Missing) > 0 {
			source += "，未含" + strings.Join(u.Missing, "、")
		}
	}
	if u.Billing == "" {
		label = "金额"
		source += "，计费方式未设置"
	}
	if u.USD != nil {
		source += fmt.Sprintf("，约 USD %.6g", *u.USD)
	}
	return fmt.Sprintf("%s · %s %s %.6g（%s）", s, label, u.Currency, *u.Cost, source)
}

func number(e event, key string) *int64 {
	v, ok := e[key].(float64)
	if !ok || v < 0 || v != math.Trunc(v) || v >= math.MaxInt64 {
		return nil
	}
	n := int64(v)
	return &n
}

func sumToken(a, b *int64) *int64 {
	if a == nil || b == nil {
		return nil
	}
	if *a > math.MaxInt64-*b {
		return nil
	}
	n := *a + *b
	return &n
}

func (p *Parser) addUsage(u Usage) {
	if !p.hasUsage {
		p.t.Usage = u
		if u.Cost != nil {
			p.t.Usage.Source = "tool"
		} else {
			p.t.Usage.Currency = ""
		}
		p.hasUsage = true
		return
	}
	// 某一步缺读数，整次相应类别就不完整，不能把已读到的部分冒充合计。
	p.t.Usage.Input = sumToken(p.t.Usage.Input, u.Input)
	p.t.Usage.Output = sumToken(p.t.Usage.Output, u.Output)
	p.t.Usage.CacheRead = sumToken(p.t.Usage.CacheRead, u.CacheRead)
	p.t.Usage.CacheWrite = sumToken(p.t.Usage.CacheWrite, u.CacheWrite)
	if u.Cost != nil && p.t.Usage.Cost != nil {
		n := *u.Cost + *p.t.Usage.Cost
		p.t.Usage.Cost, p.t.Usage.Currency, p.t.Usage.Source = &n, u.Currency, "tool"
	} else {
		p.t.Usage.Cost, p.t.Usage.Currency, p.t.Usage.Source = nil, "", ""
	}
}

func reportedCost(e event, key string) *float64 {
	if v, ok := e[key].(float64); ok && v > 0 {
		return &v
	}
	return nil
}

func snakeUsage(e event) Usage {
	return Usage{Tokens: Tokens{Input: number(e, "input_tokens"), Output: number(e, "output_tokens"), CacheRead: number(e, "cache_read_input_tokens"), CacheWrite: number(e, "cache_creation_input_tokens")}}
}
