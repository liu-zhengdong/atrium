package dispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 只合成已知事实，不把 m146 现实 null 关系升级为已知。
func installSyntheticExecution(t *testing.T, ctx context.Context, db *store.DB, mode string) {
	t.Helper()
	ptr := func(v float64) *float64 { return &v }
	unit, evidence := "tokens", "synthetic same-pool/window token denominator"
	identity := func(value string) quota.AccountIdentity {
		return quota.AccountIdentity{Kind: "accountHash", Value: value, Source: "synthetic account+organization"}
	}
	scope := &quota.SharedScope{ID: "synthetic-pool", Source: "synthetic model membership", WindowIDs: []string{"week"}}
	var rows []quota.Pace
	for _, card := range []string{"pi-A", "pi-B", "aaa-paid", "zzz-free"} {
		id := identity("A")
		if card == "pi-B" {
			id = identity("B")
		}
		total := float64(1000)
		if card == "aaa-paid" {
			total = 2000
		}
		rows = append(rows, quota.Pace{Account: card, RefreshedAt: time.Now().Format(time.RFC3339Nano), SourceFacts: quota.SourceFacts{AccountIdentity: &id, SharedScope: scope, CacheIdentityMatch: "matched", DataQuality: "cache", RefreshOutcome: "notRequested", QuotaCount: 1, QuotaLimit: 64, ValueMetricLimit: 64, ValueMetrics: []json.RawMessage{}, Quotas: []quota.SourceWindow{{ID: "week", Label: "week", UsedPercent: ptr(20), Format: "count", Unit: &unit, LimitValue: ptr(total), UsedValue: ptr(total * 0.2), SourceNote: &evidence}}}})
	}
	body, err := json.Marshal(map[string]any{"rows": rows})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO quota_cache VALUES ('openquota','openquota',?,?)`, string(body), store.Now()); err != nil {
		t.Fatal(err)
	}
	old := workers.ResolveExecution
	workers.ResolveExecution = func(_ context.Context, _ *app.Env, r workers.Resolved, host string) (workers.Resolved, error) {
		card := ""
		id := identity("A")
		switch r.Spec.Tool {
		case "pi":
			if mode == "token-pick" || mode == "token-recovery" {
				return r, nil
			}
			card = "pi-A"
			if mode == "different-account" && r.CLIModel == "opencode-go/zero-action" {
				card = "pi-B"
				id = identity("B")
			}
		case "aaa-paid", "zzz-free":
			if mode != "token-pick" && mode != "token-recovery" {
				return r, nil
			}
			card = r.Spec.Tool
		default:
			return r, nil
		}
		r.QuotaBinding = &workers.ExecutionBinding{Worker: r.ID, Host: host, Provider: "synthetic-actual-provider", Card: card, Source: "synthetic credential source + model membership", Account: id, WindowIDs: []string{"week"}}
		if r.Spec.Tool == "pi" {
			r.QuotaBinding.Scope = scope
		}
		return r, nil
	}
	t.Cleanup(func() { workers.ResolveExecution = old })
}

func TestPickTokenDemand(t *testing.T) {
	v := Pick(PickInput{Risk: "low", Tokens: 601, Facts: []Fact{
		{ID: "small", Quota: &Spare{TokenWindows: []quota.TokenWindow{{ID: "week", Available: 600}}}},
		{ID: "large", Quota: &Spare{TokenWindows: []quota.TokenWindow{{ID: "week", Available: 1200}}}},
	}})
	if v.Recommended != "large" {
		t.Fatal(v)
	}
	if err := (&Options{Tokens: -1}).check(); err == nil {
		t.Fatal("negative token demand accepted")
	}
}

func TestSharedFailurePreservesMarksAndBudget(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := hosts.EnsureLocal(ctx, db, hosts.Info{}); err != nil {
		t.Fatal(err)
	}
	for name, source := range map[string]string{
		"harness/pi":        "---\nmodel: opencode-go/quota\n---\n",
		"combos/pi+sibling": "---\nmodel: opencode-go/zero-action\n---\n",
	} {
		if _, err := workers.SaveProfile(ctx, db, name, workers.Edit{Source: &source}, "u1"); err != nil {
			t.Fatal(err)
		}
	}
	installSyntheticExecution(t, ctx, db, "known-pool")
	env := &app.Env{DB: db}
	r, err := workers.Resolve(ctx, db, "pi")
	if err != nil {
		t.Fatal(err)
	}
	r, err = workers.ResolveExecution(ctx, env, r, LocalHost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CheckExecution(ctx, env, r, LocalHost, 601); err == nil {
		t.Fatal("写死执行者不能绕过容量检查")
	}
	if _, err := CheckExecution(ctx, env, r, LocalHost, 600); err != nil {
		t.Fatal("恰好容纳应能启动", err)
	}
	base, _ := workers.MarkOf(workers.Signal{Kind: workers.SignalQuota}, r.Spec, LocalHost, time.Now())
	member := base
	member.Model = "sibling"
	member.Until = base.Since + 60000
	if err := workers.SetMark(ctx, db, base); err != nil {
		t.Fatal(err)
	}
	if err := workers.SetMark(ctx, db, member); err != nil {
		t.Fatal(err)
	}
	d := &dispatcher{env: env}
	p := &proc{binding: r.QuotaBinding, run: workers.Run{Worker: r.ID, Host: LocalHost}}
	if err := d.markSharedFailure(ctx, p, workers.Signal{Kind: workers.SignalQuota}); err != nil {
		t.Fatal(err)
	}
	marks, err := workers.Marks(ctx, db, store.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range marks {
		if m.Model == "sibling" && m.Until != member.Until {
			t.Fatal("已有标记被延长", m)
		}
	}
	targets := map[string]bool{}
	for i := 0; i < 500; i++ {
		targets[fmt.Sprintf("existing-%d", i)] = true
	}
	if pending, err := d.sharedMarks(ctx, r.QuotaBinding, base, targets); err == nil || len(pending) != 0 {
		t.Fatal("500预算必须明确拒绝，不返回部分扩展", pending, err)
	}
	if next, err := workers.Marks(ctx, db, store.Now()); err != nil || len(next) != len(marks) {
		t.Fatal("规划失败不得写部分标记", next, err)
	}
}
