package workers

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
)

func token(n int64) *int64     { return &n }
func price(n float64) *float64 { return &n }

// 真实拉起样本：dsh --profile headless --json 的脱敏日志。
func TestUsageRealLogs(t *testing.T) {
	tr, err := ReadTrace("dsh", "testdata/dsh-sample.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	want := Tokens{token(4605), token(146), token(14464), token(0)}
	if !reflect.DeepEqual(tr.Usage.Tokens, want) {
		t.Fatalf("token 得到 %+v，期望 %+v", tr.Usage, want)
	}
	if tr.Usage.Cost != nil {
		t.Fatalf("dsh 日志里没有钱数：%+v", tr.Usage)
	}
}

func TestUsageMissingFields(t *testing.T) {
	p := NewParser("dsh")
	p.Feed(`{"type":"status","phase":"step_end"}`)
	u := p.Trace().Usage
	if u.Input != nil || u.Output != nil || u.CacheRead != nil || u.CacheWrite != nil || u.Cost != nil || strings.Count(u.String(), "读不到") != 4 {
		t.Fatal(u.String())
	}
}

func TestCharge(t *testing.T) {
	r := Rules{Billing: "subscription", Prices: &Prices{Currency: "USD", Input: price(2), Output: price(10), CacheRead: price(.2), CacheWrite: price(3)}}
	base := Usage{Tokens: Tokens{token(100), token(20), token(1000), token(10)}}
	for _, c := range []struct {
		name   string
		u      Usage
		r      Rules
		source string
		cost   *float64
	}{
		{"估算", base, r, "estimate", price(.00063)},
		{"工具优先", Usage{Tokens: base.Tokens, Cost: price(.5), Currency: "USD"}, r, "tool", price(.5)},
		{"工具报明确零", Usage{Tokens: base.Tokens, Cost: price(0)}, r, "tool", price(0)},
		{"缺价", base, Rules{Billing: "metered"}, "", nil},
		{"缺token", Usage{}, r, "", nil},
		{"零花费无单价", Usage{Cost: price(0)}, Rules{}, "tool", price(0)},
	} {
		t.Run(c.name, func(t *testing.T) {
			u := Charge(c.u, c.r)
			if u.Source != c.source || (u.Cost == nil) != (c.cost == nil) || (c.cost != nil && math.Abs(*u.Cost-*c.cost) > 1e-12) {
				t.Fatal(u)
			}
			if u.Cost != nil && u.Billing == "subscription" && !strings.Contains(u.String(), "折合") {
				t.Fatal(u)
			}
		})
	}
}

// 非 USD 花费按结算那一刻的 usd_rate 折成 USD 存下；币种对不上、没写汇率就不折，USD 花费不另存。
func TestChargeUSD(t *testing.T) {
	cny := Rules{Billing: "metered", Prices: &Prices{Currency: "CNY", USDRate: price(.14), Input: price(6), Output: price(30)}}
	u := Charge(Usage{Tokens: Tokens{Input: token(1e6), Output: token(1e6)}}, cny)
	if u.Currency != "CNY" || *u.Cost != 36 || u.USD == nil || math.Abs(*u.USD-5.04) > 1e-9 || u.InUSD() != u.USD || !strings.Contains(u.String(), "约 USD 5.04") {
		t.Fatal(u, u.String())
	}
	noRate := cny
	noRate.Prices = &Prices{Currency: "CNY", Input: price(6), Output: price(30)}
	if u := Charge(Usage{Tokens: Tokens{Input: token(1e6), Output: token(1e6)}}, noRate); u.USD != nil || u.InUSD() != nil {
		t.Fatal("没写汇率不能折合", u)
	}
	if u := Charge(Usage{Cost: price(2), Currency: "EUR", USD: price(99)}, cny); u.USD != nil || u.InUSD() != nil {
		t.Fatal("工具报的货币与档案单价币种不同不能折合，旧值也要清掉", u)
	}
	usd := Charge(Usage{Cost: price(2), Currency: "USD"}, cny)
	if usd.USD != nil || *usd.InUSD() != 2 {
		t.Fatal(usd)
	}
	raw, _ := json.Marshal(usd)
	if strings.Contains(string(raw), `"usd"`) {
		t.Fatal("USD 花费不另存折合值", string(raw))
	}
}

func TestUsageAggregation(t *testing.T) {
	p := NewParser("dsh")
	p.Feed(`{"type":"status","phase":"step_end","usage":{"inputTokens":4379,"outputTokens":58,"cacheReadTokens":5120,"cacheWriteTokens":0}}`)
	p.Feed(`{"type":"status","phase":"step_end","usage":{"inputTokens":226,"outputTokens":88,"cacheReadTokens":9344,"cacheWriteTokens":0}}`)
	if u := p.Trace().Usage; *u.Input != 4605 || *u.Output != 146 || *u.CacheRead != 14464 || *u.CacheWrite != 0 || u.Cost != nil {
		t.Fatal("每步增量跨步累加", u)
	}
	// 某一步没报某类读数：这一类整次就不完整，不能把已读到的部分当合计。
	p.Feed(`{"type":"status","phase":"step_end","usage":{"inputTokens":1,"cacheReadTokens":1,"cacheWriteTokens":0}}`)
	if u := p.Trace().Usage; *u.Input != 4606 || u.Output != nil {
		t.Fatal("缺失一轮不能把部分读数当合计", u)
	}
}

func TestUsageStatsSeparateBilling(t *testing.T) {
	st := Count([]Attempt{
		{Usage: Usage{Tokens: Tokens{Input: token(10)}, Cost: price(1), Currency: "USD", Billing: "metered", Source: "tool"}},
		{Usage: Usage{Tokens: Tokens{Input: token(20)}, Cost: price(3), Currency: "USD", Billing: "metered", Source: "estimate"}},
		{Usage: Usage{Cost: price(100), Currency: "USD", Billing: "subscription", Source: "tool"}},
		{Usage: Usage{Cost: price(7), Currency: "CNY", Billing: "metered", Source: "tool"}},
		{},
	})
	if len(st.Usage) != 7 || st.Usage[0].Total != 30 || *st.Usage[0].Median != 15 || st.Usage[0].Samples != 2 {
		t.Fatal(st)
	}
	if st.Usage[4].Total != 4 || *st.Usage[4].Median != 2 || st.Usage[4].Estimated != 1 || st.Usage[5].Total != 100 || st.Usage[6].Currency != "CNY" {
		t.Fatal(st)
	}
	if !strings.Contains(st.UsageText(), "2/5 次") || !strings.Contains(st.UsageText(), "估算") {
		t.Fatal(st.UsageText())
	}
}

func TestBillingProfile(t *testing.T) {
	for _, c := range []struct {
		src string
		ok  bool
	}{
		{"billing: subscription\nprices: {currency: USD, input: 2, output: 10}", true},
		{"billing: metered", true},
		{"billing: free", false},
		{"prices: {currency: USD, input: 2}", true},
		{"billing: metered\nprices: {currency: usd, input: 2}", false},
		{"billing: metered\nprices: {currency: USD, input: -1}", false},
		{"billing: metered\nprices: {currency: CNY, usd_rate: 0.14, input: 6}", true},
		{"billing: metered\nprices: {currency: CNY, usd_rate: 0, input: 6}", false},
		{"billing: metered\nprices: {currency: CNY, usd_rate: -0.14, input: 6}", false},
		{"billing: metered\nprices: {currency: USD, usd_rate: 1, input: 6}", false},
	} {
		keys, _, err := SplitSource("---\n" + c.src + "\n---\n")
		if err != nil {
			t.Fatal(err)
		}
		err = CheckProfile("combos/dsh+deepseek-v4", keys)
		if (err == nil) != c.ok {
			t.Fatalf("%s: %v", c.src, err)
		}
	}
}

func TestExitText(t *testing.T) {
	if _, err := ExitText(`{"n":`); err == nil {
		t.Fatal("损坏记录须报错")
	}
	text, err := ExitText(`{"n":1,"outcome":"ok","usage":{"input":null,"output":null,"cache_read":null,"cache_write":null,"cost":null}}`)
	if err != nil || strings.Count(text, "读不到") != 4 {
		t.Fatal(text, err)
	}
}
