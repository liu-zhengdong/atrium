package workers

import (
	"context"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/org/leaders"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLeaderRefusal(t *testing.T) {
	base := Resolved{Rules: Rules{Trust: "high", MaxRisk: "high", Billing: "subscription"}}
	no := false
	for _, c := range []struct {
		name           string
		rules          Rules
		tried, allowed bool
	}{
		{"equal", base.Rules, false, true},
		{"unknown", Rules{Billing: "subscription"}, false, false},
		{"low", Rules{Trust: "low", MaxRisk: "high", Billing: "subscription"}, false, false},
		{"medium", Rules{Trust: "medium", MaxRisk: "high", Billing: "subscription"}, false, false},
		{"risk", Rules{Trust: "high", MaxRisk: "medium", Billing: "subscription"}, false, false},
		{"auto-false", Rules{Trust: "high", Auto: &no, Billing: "subscription"}, false, false},
		{"trae-metered", Rules{Trust: "high", Billing: "metered"}, false, false},
		{"tried", base.Rules, true, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := Resolved{Rules: c.rules}
			got := leaderRefusal(base, r, c.tried)
			if (got == "") != c.allowed {
				t.Fatalf("got %q allowed=%v", got, c.allowed)
			}
		})
	}
}

func TestLeaderPreferenceKeepsCodex(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	for tool, price := range map[string]int{"codex": 2, "pi": 0} {
		src := "---\ntrust: high\nmax_risk: high\nbilling: subscription\nprices: {currency: USD, input: 0, output: 0, cache_read: 0, cache_write: 0}\n---\n"
		if price != 0 {
			src = "---\ntrust: high\nmax_risk: high\nbilling: subscription\nprices: {currency: USD, input: 2, output: 2, cache_read: 2, cache_write: 2}\n---\n"
		}
		if _, err := SaveProfile(ctx, db, "harness/"+tool, Edit{Source: &src}, "test"); err != nil {
			t.Fatal(err)
		}
		name := tool
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0700); err != nil {
			t.Fatal(err)
		}
	}
	r, err := selectLeader(ctx, &app.Env{DB: db}, leaders.Launch{Profile: "codex:high", Attempt: &leaders.Attempt{Preferred: []string{"codex:high"}}, Env: map[string]string{platform.EnvKey(runtime.GOOS, "PATH"): dir, platform.EnvKey(runtime.GOOS, "PATHEXT"): ".EXE"}})
	if err != nil || r.ID != "codex:high" {
		t.Fatalf("可用长期首选不能因免费pi而自动换回：%s %v", r.ID, err)
	}
}
