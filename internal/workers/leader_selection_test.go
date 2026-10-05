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
	"strconv"
	"strings"
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

// 可用且点名的长期首选不能因为目录里还有免费档就被自动换掉。
func TestLeaderPreferenceKeepsPreferred(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	for _, c := range []struct {
		combo string
		input int
	}{{"dsh+aaa", 2}, {"dsh+bbb", 0}} {
		src := "---\nmodel: fake/" + strings.TrimPrefix(c.combo, "dsh+") +
			"\ntrust: high\nmax_risk: high\nbilling: subscription\nprices: {currency: USD, input: " +
			strconv.Itoa(c.input) + ", output: " + strconv.Itoa(c.input) + ", cache_read: " + strconv.Itoa(c.input) + ", cache_write: " + strconv.Itoa(c.input) + "}\n---\n"
		if _, err := SaveProfile(ctx, db, "combos/"+c.combo, Edit{Source: &src}, "test"); err != nil {
			t.Fatal(err)
		}
	}
	name := "dsh"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if err := os.WriteFile(filepath.Join(dir, name), nil, 0700); err != nil {
		t.Fatal(err)
	}
	r, err := selectLeader(ctx, &app.Env{DB: db}, leaders.Launch{Profile: "dsh+aaa", Attempt: &leaders.Attempt{Preferred: []string{"dsh+aaa"}}, Env: map[string]string{platform.EnvKey(runtime.GOOS, "PATH"): dir, platform.EnvKey(runtime.GOOS, "PATHEXT"): ".EXE"}})
	if err != nil || r.ID != "dsh+fake/aaa" {
		t.Fatalf("可用长期首选不能因免费档而自动换掉：%s %v", r.ID, err)
	}
}
