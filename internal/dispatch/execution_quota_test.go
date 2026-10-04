package dispatch

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 合成绑定：pi 的组合都算经 magpie 的同一个 provider；different-account 让 sibling 走另一个 provider。
func installSyntheticExecution(t *testing.T, mode string) {
	t.Helper()
	old := workers.ResolveExecution
	workers.ResolveExecution = func(_ context.Context, _ *app.Env, r workers.Resolved, host string) (workers.Resolved, error) {
		if r.Spec.Tool != "pi" {
			return r, nil
		}
		provider := "synthetic"
		if mode == "different-account" && r.CLIModel == "opencode-go/zero-action" {
			provider = "other"
		}
		r.QuotaBinding = &workers.ExecutionBinding{Worker: r.ID, Host: host, Provider: provider}
		return r, nil
	}
	t.Cleanup(func() { workers.ResolveExecution = old })
}

func magpieReading(provider string, used float64, resetAt int64) quota.Reading {
	return quota.Reading{Account: quota.MagpieAccount, OK: true, ReadAt: store.Now(),
		Plans: []quota.MagpiePlan{{Provider: provider, Windows: []quota.Window{{ID: "7d", Used: used, ResetsAt: resetAt}}}}}
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
	installSyntheticExecution(t, "known-pool")
	env := &app.Env{DB: db}
	r, err := workers.Resolve(ctx, db, "pi")
	if err != nil {
		t.Fatal(err)
	}
	r, err = workers.ResolveExecution(ctx, env, r, LocalHost)
	if err != nil {
		t.Fatal(err)
	}
	if err := quota.Record(ctx, db, LocalHost, []quota.Reading{magpieReading("synthetic", 85, 0)}); err != nil {
		t.Fatal(err)
	}
	if _, err := CheckExecution(ctx, env, r, LocalHost, 0); err == nil || !strings.Contains(err.Error(), "额度将满") {
		t.Fatal("写死执行者也不能绕过窗口将满", err)
	}
	if err := quota.Record(ctx, db, LocalHost, []quota.Reading{magpieReading("synthetic", 50, 0)}); err != nil {
		t.Fatal(err)
	}
	if _, err := CheckExecution(ctx, env, r, LocalHost, 0); err != nil {
		t.Fatal("窗口有余应能启动", err)
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

// 重试节奏：额度用尽而报文没写恢复时刻，经 magpie 的组合按 magpie 窗口的重置时间恢复；读数未知或直连仍按 Hold。
func TestQuotaResetFromMagpie(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	reset := store.Now() + 90*60_000
	if err := quota.Record(ctx, db, LocalHost, []quota.Reading{magpieReading("cursor", 100, reset)}); err != nil {
		t.Fatal(err)
	}
	d := &dispatcher{env: &app.Env{DB: db}}
	bound := &workers.ExecutionBinding{Worker: "pi+cursor/auto", Host: LocalHost, Provider: "cursor"}
	quotaSig := workers.Signal{Kind: workers.SignalQuota}
	for _, tc := range []struct {
		name    string
		binding *workers.ExecutionBinding
		sig     workers.Signal
		want    int64
	}{
		{"magpie-reset", bound, quotaSig, reset},
		{"message-wins", bound, workers.Signal{Kind: workers.SignalQuota, ResetAt: 42}, 42},
		{"direct", nil, quotaSig, 0},
		{"other-host-unknown", &workers.ExecutionBinding{Worker: bound.Worker, Host: "h3", Provider: "cursor"}, quotaSig, 0},
		{"not-quota", bound, workers.Signal{Kind: workers.SignalNoStart}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sig, err := d.quotaReset(ctx, &proc{binding: tc.binding}, tc.sig)
			if err != nil || sig.ResetAt != tc.want {
				t.Fatalf("resetAt=%d want %d err=%v", sig.ResetAt, tc.want, err)
			}
			m, ok := workers.MarkOf(sig, workers.Spec{Tool: "pi", Model: "cursor/auto"}, LocalHost, time.Now())
			if tc.name == "magpie-reset" && (!ok || m.Until != reset) {
				t.Fatal("标记应在 magpie 窗口重置时恢复", m)
			}
			if tc.name == "direct" && (!ok || m.Until-m.Since != workers.Hold.Milliseconds()) {
				t.Fatal("未知仍按 Hold", m)
			}
		})
	}
}
