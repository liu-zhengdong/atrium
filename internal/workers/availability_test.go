package workers

import (
	"context"
	"encoding/json"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
	"os"
	"path/filepath"
	"testing"
)

func TestAvailabilityActualSourceContract(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	b, err := os.ReadFile("../quota/testdata/pace-m146.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []quota.Pace
	if err := json.Unmarshal(b, &rows); err != nil {
		t.Fatal(err)
	}
	for _, match := range []string{"unknown", "matched", "mismatched"} {
		rows[0].CacheIdentityMatch = match
		rows[0].AccountIdentity = &quota.AccountIdentity{Kind: "accountHash", Value: "synthetic", Source: "synthetic"}
		body, err := json.Marshal(map[string]any{"rows": rows})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO quota_cache VALUES ('openquota','openquota',?,?) ON CONFLICT(account) DO UPDATE SET body=excluded.body`, string(body), store.Now()); err != nil {
			t.Fatal(err)
		}
		a, err := LoadAvailability(ctx, &app.Env{DB: db, Paths: config.Paths{Data: dir}})
		if err != nil {
			t.Fatal(err)
		}
		for _, host := range []string{"h1", "h2"} {
			for _, endpoint := range []string{"", quota.MagpieURL + "/v1"} {
				model := "opencode-go/a"
				r := Resolved{ID: "pi+" + model, Spec: Spec{Tool: "pi", Model: model}, CLIModel: model, Rules: Rules{Endpoint: endpoint}}
				r.QuotaBinding = MagpieBinding(r, host, quota.MagpieURL)
				sp, why := a.CheckResolved(r, host)
				if sp.Percent != nil || sp.Stop != "" || why != "" {
					t.Fatal("OpenQuota 月 100% 不参与派活避让", match, host, model, sp, why)
				}
			}
		}
	}
	t.Log("预期 OpenQuota 读数（月100/周25）不喂派活避让，直连与经 magpie 的组合都按未知；实际符合")
}

func TestAvailabilityUnknownScope(t *testing.T) {
	now := store.Now()
	for _, finger := range []string{"same-key", "different-key", ""} {
		a := Availability{Now: now, Reserve: 20, Readings: []quota.Stored{
			{Host: "h1", Reading: quota.Reading{Account: "opencode", OK: true, Finger: "same-key", Plan: "Go", ReadAt: now, Windows: []quota.Window{{ID: "month", Used: 100}}}},
			{Host: "h2", Reading: quota.Reading{Account: "opencode", OK: true, Finger: finger, Plan: "Go", ReadAt: now, Windows: []quota.Window{{ID: "week", Used: 25}}}},
		}, Marks: []Mark{{Tool: "pi", Model: "opencode-go/a", Host: "h1", Kind: SignalQuota, Until: now + 1000, Reason: "额度用尽"}}}
		for _, tc := range []struct {
			host, tool, model string
			blocked           bool
		}{
			{"h1", "pi", "opencode-go/a", true},
			{"h1", "pi", "opencode-go/b", false},
			{"h1", "opencode", "opencode-go/a", false},
			{"h2", "pi", "opencode-go/a", false},
			{"h3", "pi", "opencode-go/a", false},
		} {
			sp, why := a.Check(Spec{Tool: tc.tool, Model: tc.model}, tc.host)
			if sp.Percent != nil || sp.Stop != "" || (why != "") != tc.blocked {
				t.Fatalf("finger=%q case=%+v sp=%+v why=%s", finger, tc, sp, why)
			}
		}
		a.Now += 1001
		if _, why := a.Check(Spec{Tool: "pi", Model: "opencode-go/a"}, "h1"); why != "" {
			t.Fatal("到期不能重建", why)
		}
	}
}

func TestAvailabilityCacheIsNotBinding(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, used := range []float64{0, 80, 100} {
		if err := quota.Record(ctx, db, "h1", []quota.Reading{{Account: "opencode", OK: true, Finger: "key", ReadAt: store.Now(), Windows: []quota.Window{{ID: "month", Used: used}}}}); err != nil {
			t.Fatal(err)
		}
		a, err := LoadAvailability(ctx, &app.Env{DB: db, Paths: config.Paths{Data: dir}})
		if err != nil {
			t.Fatal(err)
		}
		if len(a.Readings) != 1 {
			t.Fatal("丢机器来源", a)
		}
		sp, why := a.CheckResolved(Resolved{Spec: Spec{Tool: "pi", Model: "opencode-go/a"}}, "h1")
		if sp.Percent != nil || sp.Stop != "" || why != "" {
			t.Fatal("未关联当前凭据/池的读数必须未知", sp, why)
		}
	}
	r := Resolved{Spec: Spec{Tool: "pi", Model: "alias"}, CLIModel: "opencode-go/actual"}
	if r.Account() != "opencode-go" {
		t.Fatal("实际provider不应别名成套餐", r.Account())
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
