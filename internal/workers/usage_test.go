package workers

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
)

func token(n int64) *int64     { return &n }
func price(n float64) *float64 { return &n }

// 真实拉起样本：新摘录仅保留用量字段；其余读取已有脱敏日志。
func TestUsageRealLogs(t *testing.T) {
	cases := []struct {
		tool, path string
		want       Tokens
		cost       *float64
	}{
		{"claude", "claude-t632-usage.ndjson", Tokens{token(112), token(42891), token(3933987), token(105128)}, price(3.8480145)},
		{"codex", "codex-t637-usage.ndjson", Tokens{token(47190), token(12190), token(756096), token(0)}, nil},
		{"cursor", "cursor-t476.jsonl", Tokens{token(134), token(45847), token(10632043), token(184351)}, nil},
		{"agy", "agy-t349.jsonl", Tokens{token(152011), token(6597), token(1048683), nil}, nil},
		{"opencode", "opencode-t597-usage.ndjson", Tokens{token(2136), token(1833), token(300544), token(0)}, price(0.0016538032)},
		{"grok", "grok-messages-windows.jsonl", Tokens{}, nil},
	}
	for _, c := range cases {
		t.Run(c.tool, func(t *testing.T) {
			tr, err := ReadTrace(c.tool, "testdata/"+c.path)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(tr.Usage.Tokens, c.want) {
				t.Fatalf("token 得到 %+v，期望 %+v", tr.Usage, c.want)
			}
			if (tr.Usage.Cost == nil) != (c.cost == nil) || (c.cost != nil && math.Abs(*tr.Usage.Cost-*c.cost) > 1e-12) {
				t.Fatalf("花费 %+v", tr.Usage)
			}
		})
	}
}

func TestUsageMissingFields(t *testing.T) {
	b, err := os.ReadFile("testdata/claude-t632-usage.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	var e map[string]any
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatal(err)
	}
	delete(e, "usage")
	delete(e, "total_cost_usd")
	b, _ = json.Marshal(e)
	p := NewParser("claude")
	p.Feed(string(b))
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
	claude := NewParser("claude")
	claude.Feed(`{"type":"result","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"total_cost_usd":1}
{"type":"result","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"total_cost_usd":3}`)
	if u := claude.Trace().Usage; *u.Cost != 3 || *u.Input != 20 {
		t.Fatal("Claude 多轮花费只取最后累计值", u)
	}
	p := NewParser("codex")
	p.Feed(`{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":30,"output_tokens":20,"cache_write_input_tokens":0}}
{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":50,"output_tokens":40,"cache_write_input_tokens":0}}`)
	if u := p.Trace().Usage; *u.Input != 220 || *u.CacheRead != 80 || *u.Output != 60 {
		t.Fatal(u)
	}
	p.Feed(`{"type":"turn.completed"}`)
	if u := p.Trace().Usage; u.Input != nil || u.Output != nil {
		t.Fatal("缺失一轮不能把部分读数当合计", u)
	}
	p = NewParser("grok")
	p.Feed(`{"type":"result","usage":{"input_tokens":12,"output_tokens":4,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"total_cost_usd":0}`)
	if u := p.Trace().Usage; *u.Input != 12 || u.Cost != nil {
		t.Fatal(u)
	}
}

// pi 与 opencode 的 cost 字段明确报的零要保留（免费渠道真报 0）；字段缺席仍当没报。
func TestUsageExplicitZero(t *testing.T) {
	p := NewParser("pi")
	p.Feed(`{"type":"message_end","message":{"role":"assistant","provider":"opencode-go","model":"glm-5.3-flash","usage":{"input":10,"output":4,"cost":{"total":0}}}}`)
	p.Feed(`{"type":"message_end","message":{"role":"assistant","provider":"opencode-go","model":"glm-5.3-flash","usage":{"input":20,"output":6,"cost":{"total":0}}}}`)
	if u := p.Trace().Usage; u.Cost == nil || *u.Cost != 0 || u.Source != "tool" || u.Currency != "USD" || *u.Input != 30 {
		t.Fatal("明确报的零花费要保留", u)
	}
	p = NewParser("pi")
	p.Feed(`{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":4}}}`)
	if u := p.Trace().Usage; u.Cost != nil || u.Source != "" {
		t.Fatal("字段缺席仍当没报", u)
	}
	p = NewParser("opencode")
	p.Feed(`{"type":"step_finish","part":{"reason":"stop","cost":0,"tokens":{"input":7,"output":2,"cache":{"read":0,"write":0}}}}`)
	if u := p.Trace().Usage; u.Cost == nil || *u.Cost != 0 || u.Source != "tool" {
		t.Fatal("明确报的零花费要保留", u)
	}
	p = NewParser("opencode")
	p.Feed(`{"type":"step_finish","part":{"reason":"stop","cost":-1,"tokens":{"input":7,"output":2}}}`)
	if u := p.Trace().Usage; u.Cost != nil {
		t.Fatal("负数花费仍当没报", u)
	}
	p = NewParser("opencode")
	p.Feed(`{"type":"step_finish","part":{"reason":"stop","tokens":{"input":7,"output":2}}}`)
	if u := p.Trace().Usage; u.Cost != nil {
		t.Fatal("字段缺席仍当没报", u)
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
		err = CheckProfile("combos/codex+gpt-6.1-sol", keys)
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
