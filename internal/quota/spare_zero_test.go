package quota_test

import (
	"context"
	"math"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/dispatch"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestSpareOfZeroUsage(t *testing.T) {
	for _, tc := range []struct {
		name string
		pace quota.Pace
		want *float64
		stop bool
	}{
		{"零用量缺进度", quota.Pace{UsedPercent: zeroPtr(0)}, zeroPtr(0), false},
		{"已有进度", quota.Pace{UsedPercent: zeroPtr(0), ElapsedPct: zeroPtr(50), SparePercent: zeroPtr(50)}, zeroPtr(50), false},
		{"已有富余", quota.Pace{UsedPercent: zeroPtr(0), SparePercent: zeroPtr(12)}, zeroPtr(12), false},
		{"缺用量", quota.Pace{}, nil, false},
		{"非零缺进度", quota.Pace{UsedPercent: zeroPtr(0.1)}, nil, false},
		{"负用量", quota.Pace{UsedPercent: zeroPtr(-1)}, nil, false},
		{"非有限用量", quota.Pace{UsedPercent: zeroPtr(math.NaN())}, nil, false},
		{"坏进度", quota.Pace{UsedPercent: zeroPtr(0), ElapsedPct: zeroPtr(101)}, nil, false},
		{"旧读数保留标记", quota.Pace{UsedPercent: zeroPtr(0), Stale: true}, zeroPtr(0), false},
		{"短窗用尽仍不派", quota.Pace{UsedPercent: zeroPtr(0), ShortUsedPct: zeroPtr(100)}, zeroPtr(0), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := quota.SpareOf(quota.Line{Pace: tc.pace}, 20)
			if !reflect.DeepEqual(got.Percent, tc.want) || (got.Stop != "") != tc.stop || got.Stale != tc.pace.Stale {
				t.Fatalf("got %+v, want percent=%v stop=%v", got, tc.want, tc.stop)
			}
			if tc.pace.SparePercent == nil && got.Percent != nil && tc.pace.ElapsedPct != nil {
				t.Fatal("不应覆盖已给出的周期进度")
			}
		})
	}
}

func TestSparesZeroUsageCache(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}}
	body := `{"rows":[{"providerId":"antigravity","usedPercent":0},{"providerId":"kimi","usedPercent":0},{"providerId":"codex","usedPercent":30},{"providerId":"claude","usedPercent":60,"periodElapsedPercent":50}]}`
	if _, err := db.ExecContext(ctx, `INSERT INTO quota_cache (account, tool, body, read_at) VALUES (?, ?, ?, ?)`, "openquota", "openquota", body, store.Now()); err != nil {
		t.Fatal(err)
	}
	got, err := quota.Spares(ctx, env)
	if err != nil {
		t.Fatal(err)
	}
	for _, account := range []string{"antigravity", "kimi"} {
		if got[account].Percent == nil || *got[account].Percent != 0 || got[account].Stop != "" {
			t.Fatalf("%s: %+v", account, got[account])
		}
	}
	if got["codex"].Percent != nil || got["cursor"].Percent != nil || got["claude"].Percent == nil || *got["claude"].Percent != -10 {
		t.Fatalf("非零、无数据与负富余判定错误：%+v", got)
	}
	for _, tc := range []struct {
		name  string
		other *float64
		want  string
	}{
		{"零富余优于负富余", zeroPtr(-10), "agy"},
		{"零富余优于无数据", nil, "agy"},
		{"正富余优于零富余", zeroPtr(10), "claude"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got["claude"] = quota.Spare{Account: "claude", Percent: tc.other}
			view := dispatch.Pick(dispatch.PickInput{Risk: "low", Facts: []dispatch.Fact{
				{ID: "claude", Tool: "claude", Account: "claude", Trust: "medium", MaxRisk: "low"},
				{ID: "agy", Tool: "agy", Account: "antigravity", Trust: "medium", MaxRisk: "low"},
			}, Spares: got})
			if view.Recommended != tc.want {
				t.Fatalf("推荐错误：%+v", view)
			}
		})
	}
}

func zeroPtr(v float64) *float64 { return &v }
