package workers

import (
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/quota"
)

func TestExecutionQuotaConstraints(t *testing.T) {
	now := time.Now()
	ptr := func(v float64) *float64 { return &v }
	unit, evidence := "tokens", "synthetic: same pool/window token denominator"
	id := quota.AccountIdentity{Kind: "accountHash", Value: "A", Source: "synthetic account+organization"}
	for _, tc := range []struct {
		name     string
		change   func(*Resolved, *quota.Pace)
		need     int64
		stop     bool
		capacity bool
	}{
		{"fits", nil, 600, false, true},
		{"too-large", nil, 601, true, true},
		{"unknown-demand", nil, 0, false, true},
		{"monthly100-weekly25", func(_ *Resolved, p *quota.Pace) { p.Quotas[1].UsedPercent = ptr(100) }, 1, true, true},
		{"zero-reading-success", func(_ *Resolved, p *quota.Pace) { p.Quotas[0].UsedPercent = ptr(0) }, 1, false, true},
		{"dollars", func(_ *Resolved, p *quota.Pace) { u := "USD"; p.Quotas[0].Unit = &u; p.Quotas[0].Format = "dollars" }, 601, false, false},
		{"count", func(_ *Resolved, p *quota.Pace) { u := "requests"; p.Quotas[0].Unit = &u }, 601, false, false},
		{"unknown-unit", func(_ *Resolved, p *quota.Pace) { p.Quotas[0].Unit = nil }, 601, false, false},
		{"estimated", func(_ *Resolved, p *quota.Pace) { p.Quotas[0].Estimated = true }, 601, false, false},
		{"no-denominator-evidence", func(_ *Resolved, p *quota.Pace) { p.Quotas[0].SourceNote = nil }, 601, false, false},
		{"free-zero-not-token", func(_ *Resolved, p *quota.Pace) { p.Quotas[0].Unit = nil; p.Quotas[0].RemainingValue = ptr(0) }, 601, false, false},
		{"token-total-zero", func(_ *Resolved, p *quota.Pace) { p.Quotas[0].LimitValue = ptr(0); p.Quotas[0].UsedValue = ptr(0) }, 1, true, true},
		{"explicit-zero", func(_ *Resolved, p *quota.Pace) { p.Quotas[0].RemainingValue = ptr(0) }, 1, true, true},
		{"stale", func(_ *Resolved, p *quota.Pace) { p.RefreshedAt = now.Add(-11 * time.Minute).Format(time.RFC3339Nano) }, 601, false, false},
		{"future", func(_ *Resolved, p *quota.Pace) { p.RefreshedAt = now.Add(time.Minute).Format(time.RFC3339Nano) }, 601, false, false},
		{"failed-old-A-for-B", func(r *Resolved, p *quota.Pace) { r.QuotaBinding.Account.Value = "B"; p.RefreshOutcome = "failed" }, 601, false, false},
		{"mismatched", func(_ *Resolved, p *quota.Pace) { p.CacheIdentityMatch = "mismatched" }, 601, false, false},
		{"unknown-match", func(_ *Resolved, p *quota.Pace) { p.CacheIdentityMatch = "unknown" }, 601, false, false},
		{"missing-bound-window", func(_ *Resolved, p *quota.Pace) { p.Quotas = p.Quotas[:1] }, 601, false, false},
		{"unknown-binding", func(r *Resolved, _ *quota.Pace) { r.QuotaBinding = nil }, 601, false, false},
		{"unknown-reset", nil, 600, false, true},
		{"expired-reset", func(_ *Resolved, p *quota.Pace) {
			v := now.Add(-time.Minute).Format(time.RFC3339Nano)
			p.Quotas[1].ResetsAt = &v
		}, 601, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := Resolved{ID: "pi+actual/a", Spec: Spec{Tool: "pi", Model: "actual/a"}, QuotaBinding: &ExecutionBinding{Worker: "pi+actual/a", Host: quota.LocalHost, Provider: "actual", Card: "card", Source: evidence, Account: id, WindowIDs: []string{"week", "month"}}}
			p := quota.Pace{Account: "card", RefreshedAt: now.Format(time.RFC3339Nano), SourceFacts: quota.SourceFacts{AccountIdentity: &id, CacheIdentityMatch: "matched", DataQuality: "cache", Quotas: []quota.SourceWindow{
				{ID: "week", UsedPercent: ptr(25), LimitValue: ptr(1000), UsedValue: ptr(200), Unit: &unit, SourceNote: &evidence, Format: "count"},
				{ID: "month", UsedPercent: ptr(25), Format: "percent"},
			}}}
			if tc.change != nil {
				tc.change(&r, &p)
			}
			a := Availability{Now: now.UnixMilli(), Reserve: 20, Sources: []quota.Pace{p}}
			sp, why := a.CheckResolved(r, quota.LocalHost, tc.need)
			if why != "" || (sp.Stop != "") != tc.stop || (len(sp.TokenWindows) > 0) != tc.capacity {
				t.Fatalf("sp=%+v why=%s want stop=%v capacity=%v", sp, why, tc.stop, tc.capacity)
			}
			if tc.name == "fits" {
				c := sp.TokenWindows[0]
				if c.Total != 1000 || c.Used != 200 || c.Remaining != 800 || c.Available != 600 {
					t.Fatal(c)
				}
			}
			t.Logf("expected stop=%v capacity=%v; actual stop=%q token_windows=%d", tc.stop, tc.capacity, sp.Stop, len(sp.TokenWindows))
		})
	}
}

func TestExecutionSamePool(t *testing.T) {
	a := ExecutionBinding{Provider: "actual", Source: "execution proof", Account: quota.AccountIdentity{Kind: "accountHash", Value: "A", Source: "account+organization"}, Scope: &quota.SharedScope{ID: "pool", Source: "synthetic pool proof", WindowIDs: []string{"week"}}, WindowIDs: []string{"week"}}
	for _, tc := range []struct {
		name   string
		change func(*ExecutionBinding)
		want   bool
	}{
		{"same-pool-other-model", func(b *ExecutionBinding) { b.Worker = "other/model" }, true},
		{"different-account", func(b *ExecutionBinding) { b.Account.Value = "B" }, false},
		{"unknown-pool", func(b *ExecutionBinding) { b.Scope = nil }, false},
		{"different-boundary", func(b *ExecutionBinding) { b.Account.Source = "other" }, false},
		{"different-window", func(b *ExecutionBinding) { b.WindowIDs = []string{"month"} }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := a
			tc.change(&b)
			if got := SamePool(&a, &b); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
