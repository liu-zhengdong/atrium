package workers

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestAvailabilityScopes(t *testing.T) {
	now := time.Now().UnixMilli()
	reading := func(host, finger, plan string, used float64) quota.Stored {
		return quota.Stored{Host: host, Reading: quota.Reading{Account: "opencode", Finger: finger, Plan: plan,
			OK: true, ReadAt: now, Windows: []quota.Window{{ID: "monthly", Used: used}}}}
	}
	a := Availability{Now: now, Reserve: 20, Readings: []quota.Stored{
		reading("h1", "one", "Go", 100), reading("h2", "two", "Go", 0), reading("h3", "one", "Go", 0),
		reading("h4", "one", "Other", 0),
	}, Marks: []Mark{{Tool: "pi", Model: "opencode-go/a", Host: "h1", Kind: SignalQuota, Until: now + 1000, Reason: "额度用尽"}}}
	for _, tc := range []struct {
		name, tool, model, host string
		blocked                 bool
	}{
		{"同套餐同工具其他模型", "pi", "opencode-go/b", "h1", true},
		{"同套餐跨工具", "opencode", "opencode-go/b", "h1", true},
		{"不同provider", "pi", "other/b", "h1", false},
		{"不同账号", "pi", "opencode-go/b", "h2", false},
		{"已知同账号同套餐", "pi", "opencode-go/b", "h3", true},
		{"不同套餐", "pi", "opencode-go/b", "h4", false},
		{"未知账号关系", "pi", "opencode-go/b", "h5", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, why := a.Check(Spec{Tool: tc.tool, Model: tc.model}, tc.host)
			if (why != "") != tc.blocked {
				t.Fatalf("blocked=%v，原因=%s", tc.blocked, why)
			}
		})
	}
	a.Now += 1001
	a.Readings = nil
	if _, why := a.Check(Spec{Tool: "pi", Model: "opencode-go/b"}, "h1"); why != "" {
		t.Fatal("标记到期后不应循环重建", why)
	}
}

func TestAvailabilityCachedReserveAndUnknown(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}}
	for _, used := range []float64{0, 80, 100} {
		if err := quota.Record(ctx, db, "h2", []quota.Reading{{Account: "opencode", OK: true, Plan: "Go",
			Finger: "two", ReadAt: store.Now(), Windows: []quota.Window{{ID: "month", Used: used}}}}); err != nil {
			t.Fatal(err)
		}
		a, err := LoadAvailability(ctx, env)
		if err != nil {
			t.Fatal(err)
		}
		sp, why := a.Check(Spec{Tool: "pi", Model: "opencode-go/a"}, "h2")
		if (why != "") != (used >= 80) {
			t.Fatalf("used=%v spare=%+v reason=%s", used, sp, why)
		}
		if used == 0 && (sp.Percent == nil || *sp.Percent != 0) {
			t.Fatal("零读数应可用", sp)
		}
		unknown, why := a.Check(Spec{Tool: "pi", Model: "opencode-go/a"}, "h3")
		if unknown.Percent != nil || why != "" {
			t.Fatal("另一账号未知不能沿用 h2 摘要", unknown, why)
		}
	}
}

func TestSilentReverseCases(t *testing.T) {
	zero := int64(0)
	base := Trace{Ended: true, Usage: Usage{Tokens: Tokens{&zero, &zero, &zero, &zero}}}
	for _, tc := range []struct {
		name            string
		change          func(*Trace)
		delivered, want bool
	}{
		{"完整零读数空转", func(*Trace) {}, false, true},
		{"正常零读数回复", func(t *Trace) { t.Result = "已交付" }, false, false},
		{"正常零读数动作", func(t *Trace) { t.Segments = []Segment{{Cmds: []Command{{Cmd: "write output"}}}} }, false, false},
		{"正常零读数产出", func(*Trace) {}, true, false},
		{"usage缺失", func(t *Trace) { t.Usage = Usage{} }, false, false},
		{"缓存读数缺失", func(t *Trace) { t.Usage.CacheRead = nil }, false, false},
		{"未知事件", func(t *Trace) { t.Unknown = 1 }, false, false},
		{"未解析产出", func(t *Trace) { t.Lines = []string{"产出"} }, false, false},
		{"还没收尾", func(t *Trace) { t.Ended = false }, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tr := base
			tc.change(&tr)
			if got := Silent(tr, tc.delivered); got != tc.want {
				t.Fatalf("silent=%v want=%v", got, tc.want)
			}
		})
	}
}

func TestQuotaModelWindowsDoNotSpread(t *testing.T) {
	now := store.Now()
	a := Availability{Now: now, Reserve: 20, Readings: []quota.Stored{
		{Host: "h1", Reading: quota.Reading{Account: "codex", OK: true, ReadAt: now, Windows: []quota.Window{{ID: "session", Used: 0}, {ID: "weekly", Used: 0}, {ID: "spark", Used: 100}, {ID: "sparkWeekly", Used: 100}}}},
		{Host: "h1", Reading: quota.Reading{Account: "claude", OK: true, ReadAt: now, Windows: []quota.Window{{ID: "session", Used: 0}, {ID: "weekly", Used: 0}, {ID: "sonnet", Used: 100}}}},
	}}
	for _, tc := range []struct {
		tool, model string
		blocked     bool
	}{
		{"codex", "gpt-codex", false}, {"codex", "gpt-codex-spark", true}, {"claude", "opus", false}, {"claude", "sonnet", true},
	} {
		sp, why := a.Check(Spec{Tool: tc.tool, Model: tc.model}, "h1")
		if (why != "") != tc.blocked {
			t.Fatalf("%s+%s：%+v %s", tc.tool, tc.model, sp, why)
		}
	}
	a.Marks = []Mark{{Tool: "claude", Model: "sonnet", Host: "h1", Kind: SignalQuota, Until: now + 1000}}
	if _, why := a.Check(Spec{Tool: "claude", Model: "opus"}, "h1"); why != "" {
		t.Fatal("Sonnet 专属耗尽不能封 Opus", why)
	}
	a.Marks = []Mark{{Tool: "codex", Model: "gpt-codex-spark", Host: "h1", Kind: SignalQuota, Until: now + 1000}}
	if _, why := a.Check(Spec{Tool: "codex", Model: "gpt-codex"}, "h1"); why != "" {
		t.Fatal("Spark 专属耗尽不能封普通预算", why)
	}
}

func TestAvailabilityUsesEffectiveCLIModel(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	src := "---\nmodel: opencode-go/actual-a\n---\n"
	if _, err := SaveProfile(ctx, db, "combos/pi+alias", Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	r, err := Resolve(ctx, db, "pi+alias")
	if err != nil {
		t.Fatal(err)
	}
	if r.Account() != "opencode" {
		t.Fatal("按实际传给 CLI 的 provider 关联套餐", r)
	}
	if err := SetMark(ctx, db, Mark{Tool: "pi", Model: "alias", Host: "h1", Kind: SignalQuota, Reason: "额度用尽", Since: store.Now(), Until: store.Now() + 10000}); err != nil {
		t.Fatal(err)
	}
	a, err := LoadAvailability(ctx, &app.Env{DB: db, Paths: config.Paths{Data: dir}})
	if err != nil {
		t.Fatal(err)
	}
	if _, why := a.Check(Spec{Tool: "opencode", Model: "opencode-go/actual-b"}, "h1"); why == "" {
		t.Fatal("别名不能绕过共享套餐标记")
	}
	r.Rules.Endpoint = "https://test.invalid"
	r.Spec.Model = "other"
	if _, why := a.CheckResolved(r, "h1"); why != "" {
		t.Fatal("自定义端点不冒充同一 CLI 账号", why)
	}
}
