package workers

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/quota"
)

// viaMagpie 是经缺省 magpie 网关的组合（t965 的写法：档案端点指向网关，模型是 magpie 路由名）。
func viaMagpie(model string) Resolved {
	return Resolved{ID: "pi+" + model, Spec: Spec{Tool: "pi", Model: model}, CLIModel: model, Rules: Rules{Endpoint: quota.MagpieURL + "/v1"}}
}

func TestMagpieBinding(t *testing.T) {
	t.Setenv("ATRIUM_MAGPIE_URL", "")
	for _, tc := range []struct {
		endpoint, cliModel, provider string
	}{
		{"http://127.0.0.1:3425/v1", "zcode/GLM-5.3", "zcode"},
		{"http://localhost:3425/v1", "cursor/auto", "cursor"},
		{"http://127.0.0.1:3425", "claude/claude-sonnet-4-5", "claude"},
		{"http://127.0.0.1:3425/v1", "cursor", ""},
		{"http://127.0.0.1:3425/v1", "/auto", ""},
		{"http://127.0.0.1:3426/v1", "zcode/GLM-5.3", ""},
		{"https://127.0.0.1:3425/v1", "zcode/GLM-5.3", ""},
		{"http://127.0.0.1.evil.cn:3425/v1", "zcode/GLM-5.3", ""},
		{"", "opencode-go/glm-5.3", ""},
		{"127.0.0.1:3425", "zcode/GLM-5.3", ""},
	} {
		r := Resolved{ID: "pi+" + tc.cliModel, CLIModel: tc.cliModel, Rules: Rules{Endpoint: tc.endpoint}}
		b := MagpieBinding(r, "h1", quota.MagpieURL)
		if got := ""; b != nil {
			got = b.Provider
			if !b.Valid(r, "h1") || b.Valid(r, "h3") {
				t.Fatal("绑定只对本组合、本机器有效", b)
			}
			if got != tc.provider {
				t.Fatalf("%s %s: %q", tc.endpoint, tc.cliModel, got)
			}
		} else if tc.provider != "" {
			t.Fatalf("%s %s 应绑定 %s", tc.endpoint, tc.cliModel, tc.provider)
		}
		r2, _ := ResolveExecution(context.Background(), nil, r, "h1")
		if (r2.QuotaBinding != nil) != (tc.provider != "") {
			t.Fatal("缺省 ResolveExecution 应按端点与模型挂绑定", tc.endpoint, tc.cliModel, r2.QuotaBinding)
		}
	}
	t.Setenv("ATRIUM_MAGPIE_URL", "http://127.0.0.1:4555/")
	if r, _ := ResolveExecution(context.Background(), nil, viaMagpie("zcode/GLM-5.3"), "h1"); r.QuotaBinding != nil {
		t.Fatal("ATRIUM_MAGPIE_URL 改了网关，缺省地址的端点不再算经 magpie")
	}
	r := viaMagpie("zcode/GLM-5.3")
	r.Rules.Endpoint = "http://localhost:4555/v1"
	if r, _ = ResolveExecution(context.Background(), nil, r, "h1"); r.QuotaBinding == nil || r.QuotaBinding.Provider != "zcode" {
		t.Fatal("端点与 ATRIUM_MAGPIE_URL 同一地址应绑定", r.QuotaBinding)
	}
}

// 「窗口将满」：经 magpie 的组合按那台机器的读数避让；直连与别的机器额度未知，不连坐。
func TestExecutionQuotaMagpie(t *testing.T) {
	t.Setenv("ATRIUM_MAGPIE_URL", "")
	now := time.Now().UnixMilli()
	reading := func(host string, used float64) quota.Stored {
		return quota.Stored{Host: host, Reading: quota.Reading{Account: quota.MagpieAccount, OK: true, ReadAt: now,
			Plans: []quota.MagpiePlan{{Provider: "cursor", Plan: "Pro", Windows: []quota.Window{{ID: "Cursor models", Used: used, ResetsAt: now + 3600_000}}}}}}
	}
	via := viaMagpie("cursor/auto")
	direct := Resolved{ID: "cursor+auto", Spec: Spec{Tool: "cursor", Model: "auto"}, CLIModel: "auto"}
	for _, tc := range []struct {
		name string
		r    Resolved
		host string
		rows []quota.Stored
		stop bool
	}{
		{"full", via, "h1", []quota.Stored{reading("h1", 92)}, true},
		{"room", via, "h1", []quota.Stored{reading("h1", 40)}, false},
		{"other-host-unknown", via, "h3", []quota.Stored{reading("h1", 92)}, false},
		{"other-host-own-reading", via, "h3", []quota.Stored{reading("h1", 40), reading("h3", 95)}, true},
		{"direct-not-bound", direct, "h1", []quota.Stored{reading("h1", 92)}, false},
		{"no-binding", via, "h1", []quota.Stored{reading("h1", 92)}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := tc.r
			if tc.name != "no-binding" {
				r, _ = ResolveExecution(context.Background(), nil, r, tc.host)
			}
			a := Availability{Now: now, Reserve: 20, Readings: tc.rows}
			sp, why := a.CheckResolved(r, tc.host, 1000)
			if why != "" || (sp.Stop != "") != tc.stop || len(sp.TokenWindows) != 0 {
				t.Fatalf("sp=%+v why=%s", sp, why)
			}
			if tc.stop && !strings.Contains(sp.Stop, "Cursor models 已用") {
				t.Fatal(sp.Stop)
			}
			if tc.stop && a.QuotaReset(r.QuotaBinding) != now+3600_000 {
				t.Fatal("恢复时刻应取 magpie 窗口的重置时间")
			}
		})
	}
	a := Availability{Now: now, Reserve: 20, Readings: []quota.Stored{reading("h1", 92)}, Marks: []Mark{{Tool: "pi", Model: via.Spec.Model, Host: "h1", Kind: SignalQuota, Until: now + 1000, Reason: "额度用尽"}}}
	r, _ := ResolveExecution(context.Background(), nil, via, "h1")
	if _, why := a.CheckResolved(r, "h1"); !strings.Contains(why, "额度用尽") {
		t.Fatal("标记仍先于读数判定", why)
	}
	if a.QuotaReset(nil) != 0 {
		t.Fatal("没有绑定不给恢复时刻")
	}
}

func TestExecutionSamePool(t *testing.T) {
	a := ExecutionBinding{Worker: "pi+cursor/auto", Host: "h1", Provider: "cursor"}
	for _, tc := range []struct {
		name   string
		change func(*ExecutionBinding)
		want   bool
	}{
		{"same-provider-other-model", func(b *ExecutionBinding) { b.Worker = "pi+cursor/gpt-5" }, true},
		{"other-provider", func(b *ExecutionBinding) { b.Provider = "zai" }, false},
		{"other-host", func(b *ExecutionBinding) { b.Host = "h3" }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := a
			tc.change(&b)
			if got := SamePool(&a, &b); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
	if SamePool(&a, nil) || SamePool(nil, &a) {
		t.Fatal("没有绑定不同池")
	}
}
