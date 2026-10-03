package quota

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 假 magpie 回复：形状照 magpie c96a4ba 的 provider.Quota（网关包一层 {"object":"list","data":[…]}）。
const magpieSample = `{"object":"list","data":[
 {"provider":"cursor","name":"Cursor","kind":"subscription","plan":"Pro","user":"someone@example.com","windows":[
   {"name":"Cursor models","used":92,"remaining":8,"resetsAt":"2026-11-02T00:00:00Z"},
   {"name":"Other models","used":0,"remaining":100}]},
 {"provider":"kimi-code","name":"Kimi Code","kind":"plan","windows":[{"name":"5h","used":100,"remaining":0,"resetsAt":"2026-10-03T17:32:00Z"},{"name":"7d","used":21,"remaining":79}]},
 {"provider":"deepseek","name":"DeepSeek","kind":"balance","windows":[],"balance":"¥12.00"},
 {"provider":"claude","name":"Claude Code","kind":"subscription","windows":[],"error":"login expired"},
 {"provider":"zai","name":"Z.ai","kind":"plan","windows":[{"name":"monthly","unlimited":true,"used":0,"remaining":100}]}
]}`

func TestMagpiePlans(t *testing.T) {
	plans, err := MagpiePlans([]byte(magpieSample))
	if err != nil {
		t.Fatal(err)
	}
	if len(plans) != 2 || plans[0].Provider != "cursor" || plans[0].Plan != "Pro" || plans[1].Provider != "kimi-code" {
		t.Fatalf("余额、报错、只有不限量窗口的套餐不收：%+v", plans)
	}
	w := plans[0].Windows[0]
	if w.ID != "Cursor models" || w.Used != 92 || w.ResetsAt != time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC).UnixMilli() || w.Period != 0 {
		t.Fatalf("窗口映射：%+v", w)
	}
	if plans[0].Windows[1].ResetsAt != 0 {
		t.Fatal("没给重置时间应为 0", plans[0].Windows[1])
	}
	cli, err := MagpiePlans([]byte(`[{"provider":"codex","kind":"subscription","windows":[{"name":"7d","used":130}]}]`))
	if err != nil || len(cli) != 1 || cli[0].Windows[0].Used != 100 {
		t.Fatalf("命令行数组同样认，超 100 按 100：%+v %v", cli, err)
	}
	if empty, err := MagpiePlans([]byte(`{"object":"list","data":[]}`)); err != nil || len(empty) != 0 {
		t.Fatal("空列表是成功读数", empty, err)
	}
	many := `[` + strings.Repeat(`{"provider":"p","windows":[]},`, magpiePlans) + `{"provider":"p","windows":[]}]`
	for name, raw := range map[string]string{
		"not-json":       `<html>`,
		"no-data":        `{"object":"list"}`,
		"used-missing":   `{"data":[{"provider":"a","windows":[{"name":"7d"}]}]}`,
		"used-negative":  `{"data":[{"provider":"a","windows":[{"name":"7d","used":-1}]}]}`,
		"no-name":        `{"data":[{"provider":"a","windows":[{"used":1}]}]}`,
		"no-provider":    `{"data":[{"windows":[{"name":"7d","used":1}]}]}`,
		"bad-reset":      `{"data":[{"provider":"a","windows":[{"name":"7d","used":1,"resetsAt":"明天"}]}]}`,
		"too-many-plans": many,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := MagpiePlans([]byte(raw)); err == nil {
				t.Fatal("坏回复未拒绝")
			}
		})
	}
}

func TestMagpieSpare(t *testing.T) {
	now := time.Now().UnixMilli()
	hour := int64(3600_000)
	row := func(host string, at int64, plans ...MagpiePlan) Stored {
		return Stored{Host: host, Reading: Reading{Account: MagpieAccount, OK: true, ReadAt: at, Plans: plans}}
	}
	plan := func(provider string, ws ...Window) MagpiePlan {
		return MagpiePlan{Provider: provider, Plan: "Pro", Windows: ws}
	}
	full := Window{ID: "7d", Used: 92, ResetsAt: now + 2*hour}
	for _, tc := range []struct {
		name    string
		rows    []Stored
		known   bool
		stop    bool
		resetAt int64
	}{
		{"no-reading", nil, false, false, 0},
		{"other-host", []Stored{row("h3", now, plan("cursor", full))}, false, false, 0},
		{"other-provider", []Stored{row("h1", now, plan("zai", full))}, false, false, 0},
		{"stale", []Stored{row("h1", now-11*60_000, plan("cursor", full))}, false, false, 0},
		{"future", []Stored{row("h1", now+60_000, plan("cursor", full))}, false, false, 0},
		{"failed", []Stored{{Host: "h1", Reading: Reading{Account: MagpieAccount, Reason: "连不上 magpie 额度接口", ReadAt: now}}}, false, false, 0},
		{"below-reserve", []Stored{row("h1", now, plan("cursor", Window{ID: "7d", Used: 79.9}))}, true, false, 0},
		{"at-reserve", []Stored{row("h1", now, plan("cursor", Window{ID: "7d", Used: 80, ResetsAt: now + hour}))}, true, true, now + hour},
		{"window-full", []Stored{row("h1", now, plan("cursor", Window{ID: "5h", Used: 10}, full))}, true, true, now + 2*hour},
		{"two-full-windows", []Stored{row("h1", now, plan("cursor", Window{ID: "5h", Used: 100, ResetsAt: now + hour}, full))}, true, true, now + 2*hour},
		{"reset-passed", []Stored{row("h1", now, plan("cursor", Window{ID: "7d", Used: 100, ResetsAt: now - 1}))}, true, false, 0},
		{"reset-unknown", []Stored{row("h1", now, plan("cursor", Window{ID: "7d", Used: 100}))}, true, true, 0},
		{"one-account-left", []Stored{row("h1", now, plan("cursor", full), plan("cursor", Window{ID: "7d", Used: 30}))}, true, false, 0},
		{"all-accounts-full", []Stored{row("h1", now, plan("cursor", full), plan("cursor", Window{ID: "7d", Used: 99, ResetsAt: now + hour}))}, true, true, now + hour},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sp, at := MagpieSpare(tc.rows, "h1", "cursor", 20, now)
			if (sp.Account != "") != tc.known || (sp.Stop != "") != tc.stop || at != tc.resetAt || sp.Percent != nil {
				t.Fatalf("sp=%+v resetAt=%d", sp, at)
			}
			if tc.stop && (!strings.Contains(sp.Stop, "额度将满") || !strings.Contains(sp.Stop, "须给用户留 20%")) {
				t.Fatal(sp.Stop)
			}
		})
	}
}

func TestReadMagpie(t *testing.T) {
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		switch r.URL.Query().Get("case") {
		case "forbidden":
			http.Error(w, "magpie's quotas are told to another machine only when shared", http.StatusForbidden)
		case "garbage":
			w.Write([]byte("<html>secret-ish body</html>"))
		default:
			if r.URL.Path != "/v1/magpie/quotas" {
				http.NotFound(w, r)
				return
			}
			w.Write([]byte(magpieSample))
		}
	}))
	defer srv.Close()
	now := time.Now()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := "http://" + ln.Addr().String()
	ln.Close()
	for _, tc := range []struct {
		name, url, reason string
	}{
		{"ok", magpieURL(map[string]string{"ATRIUM_MAGPIE_URL": srv.URL + "/"}), ""},
		{"forbidden", srv.URL + magpiePath + "?case=forbidden", "magpie 额度接口回 HTTP 403"},
		{"garbage", srv.URL + magpiePath + "?case=garbage", "magpie 额度回复字段损坏或超限，未接受部分结果"},
		{"down", magpieURL(map[string]string{"ATRIUM_MAGPIE_URL": closed}), "连不上 magpie 额度接口"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := Deps{HTTP: srv.Client(), Now: func() time.Time { return now }, URLs: map[string]string{MagpieAccount: tc.url}}
			r := ReadAccount(context.Background(), d, MagpieAccount)
			if r.Account != MagpieAccount || r.ReadAt != now.UnixMilli() || r.OK != (tc.reason == "") || r.Reason != tc.reason {
				t.Fatalf("%+v", r)
			}
			if r.OK && len(r.Plans) != 2 {
				t.Fatal(r.Plans)
			}
		})
	}
	if auth != "" {
		t.Fatal("不应带凭据", auth)
	}
	if got := magpieURL(nil); got != "http://127.0.0.1:3425/v1/magpie/quotas" {
		t.Fatal(got)
	}
}

func TestViaMagpie(t *testing.T) {
	for _, tc := range []struct {
		endpoint, gateway string
		want              bool
	}{
		{"http://127.0.0.1:3425/v1", MagpieURL, true},
		{"http://localhost:3425/v1/", MagpieURL, true},
		{"http://127.0.0.1:3425", "http://localhost:3425/", true},
		{"https://gw.example.cn/v1", "https://gw.example.cn", true},
		{"https://gw.example.cn:443/v1", "https://gw.example.cn", true},
		{"http://127.0.0.1:3426/v1", MagpieURL, false},
		{"https://127.0.0.1:3425/v1", MagpieURL, false},
		{"http://127.0.0.1.evil.cn:3425/v1", MagpieURL, false},
		{"http://10.0.0.2:3425/v1", MagpieURL, false},
		{"127.0.0.1:3425", MagpieURL, false},
		{"", MagpieURL, false},
	} {
		if got := ViaMagpie(tc.endpoint, tc.gateway); got != tc.want {
			t.Errorf("ViaMagpie(%q, %q) = %v", tc.endpoint, tc.gateway, got)
		}
	}
}

// magpie 只在配了地址时读；读数照常经 Record 存下，但不进 quota 一览。
func TestMagpieLocalAndStore(t *testing.T) {
	if l := NewLocal(Deps{Now: time.Now}); len(l.accounts) != len(Builtin) {
		t.Fatal("没配地址不读 magpie", l.accounts)
	}
	if l := NewLocal(LocalDeps("linux", t.TempDir(), map[string]string{})); l.accounts[len(l.accounts)-1] != MagpieAccount || len(Builtin) != 3 {
		t.Fatal("LocalDeps 应读 magpie，且不改 Builtin", l.accounts, Builtin)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(magpieSample)) }))
	defer srv.Close()
	now := time.Now()
	d := Deps{HTTP: srv.Client(), Now: func() time.Time { return now }, URLs: map[string]string{MagpieAccount: srv.URL + magpiePath}}
	l := &Local{deps: d, accounts: []string{MagpieAccount}, next: map[string]time.Time{}}
	rs := l.Due(context.Background(), nil)
	if len(rs) != 1 || !rs[0].OK || len(l.Due(context.Background(), nil)) != 0 {
		t.Fatal("到期才读", rs)
	}
	ctx := context.Background()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Record(ctx, db, "h3", rs); err != nil {
		t.Fatal(err)
	}
	all, err := Cached(ctx, db)
	if err != nil || len(all) != 1 || all[0].Host != "h3" || len(all[0].Plans) != 2 {
		t.Fatal(all, err)
	}
	if sp, _ := MagpieSpare(all, "h3", "cursor", 20, now.UnixMilli()); sp.Stop == "" {
		t.Fatal("存下的读数应能判将满", sp)
	}
	ov, err := Last(ctx, &app.Env{DB: db, Paths: config.Paths{Data: dir}})
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range ov.Lines {
		if strings.Contains(line.Account, MagpieAccount) {
			t.Fatal("magpie 不进一览", line)
		}
	}
	if err := DropHost(ctx, db, "h3"); err != nil {
		t.Fatal(err)
	}
	if all, _ := Cached(ctx, db); len(all) != 0 {
		t.Fatal("移除机器应清掉它的 magpie 读数", all)
	}
}
