package dispatch

import (
	"testing"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func priceRules(n float64) workers.Rules {
	return workers.Rules{Billing: "subscription", Prices: &workers.Prices{Currency: "USD", Input: &n, Output: &n, CacheRead: &n, CacheWrite: &n}}
}

func TestPickVerifiedCosts(t *testing.T) {
	facts := []Fact{
		{ID: "paid", Trust: "high", Cost: priceRules(10), Preferred: 1},
		{ID: "unknown", Trust: "high", Preferred: 2},
		{ID: "cheap", Trust: "high", Cost: priceRules(1)},
		{ID: "free", Trust: "high", Cost: priceRules(0)},
	}
	v := Pick(PickInput{Risk: "high", Priority: ledger.Urgent, Facts: facts})
	if v.Recommended != "free" || v.Candidates[1].ID != "unknown" {
		t.Fatalf("已知免费参与选择，未知保持原位置：%+v", v)
	}
	facts[3].Trust = "low"
	v = Pick(PickInput{Risk: "high", Priority: ledger.Urgent, Facts: facts})
	if v.Recommended != "cheap" {
		t.Fatalf("免费不能降低信任条件：%+v", v)
	}
	facts[2].Cost = workers.Rules{}
	v = Pick(PickInput{Risk: "high", Priority: ledger.Urgent, Facts: facts})
	if v.Recommended != "paid" {
		t.Fatalf("未知成本保持偏好：%+v", v)
	}
	paid := priceRules(1)
	paid.Billing = "metered"
	if paid.Refusal("low", true) == "" {
		t.Fatal("不能启用未授权按量付费")
	}
	free := priceRules(0)
	free.Billing = "metered"
	if free.Refusal("low", true) != "" {
		t.Fatal("明确免费可参与自动选择")
	}
	free.Prices.CacheWrite = nil
	if workers.FreePrices(free) || free.Refusal("low", true) == "" {
		t.Fatal("缺价不能当免费")
	}
}
