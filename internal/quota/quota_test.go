package quota

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestSourcesThreePlatforms(t *testing.T) {
	files := func(ss []Source) []string {
		var out []string
		for _, s := range ss {
			out = append(out, s.String())
		}
		return out
	}
	cases := []struct {
		name string
		got  []Source
		want []string
	}{
		{"claude mac", ClaudeSources("darwin", "/Users/a", map[string]string{"USER": "a"}),
			[]string{"钥匙串「Claude Code-credentials」", "钥匙串「Claude Code-credentials」", "/Users/a/.claude/.credentials.json"}},
		{"claude linux", ClaudeSources("linux", "/home/a", nil),
			[]string{"/home/a/.claude/.credentials.json", "/home/a/.config/claude/.credentials.json"}},
		{"claude linux xdg", ClaudeSources("linux", "/home/a", map[string]string{"XDG_CONFIG_HOME": "/x"}),
			[]string{"/home/a/.claude/.credentials.json", "/x/claude/.credentials.json"}},
		{"claude windows", ClaudeSources("windows", `C:\Users\a`, nil), []string{`C:\Users\a\.claude\.credentials.json`}},
		{"claude 配置目录", ClaudeSources("linux", "/home/a", map[string]string{"CLAUDE_CONFIG_DIR": "~/cc"}), []string{"/home/a/cc/.credentials.json"}},
		{"codex", CodexSources("linux", "/home/a", nil), []string{"/home/a/.config/codex/auth.json", "/home/a/.codex/auth.json"}},
		{"codex windows", CodexSources("windows", `C:\Users\a`, nil), []string{`C:\Users\a\.config\codex\auth.json`, `C:\Users\a\.codex\auth.json`}},
		{"codex home", CodexSources("darwin", "/Users/a", map[string]string{"CODEX_HOME": "/c"}), []string{"/c/auth.json"}},
		{"opencode", OpencodeSources("darwin", "/Users/a", nil), []string{"/Users/a/.local/share/opencode/auth.json"}},
		{"opencode xdg", OpencodeSources("linux", "/home/a", map[string]string{"XDG_DATA_HOME": "/d"}), []string{"/d/opencode/auth.json"}},
		{"opencode windows", OpencodeSources("windows", `C:\Users\a`, nil), []string{`C:\Users\a\.local\share\opencode\auth.json`}},
	}
	for _, c := range cases {
		if got := files(c.got); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %q，应为 %q", c.name, got, c.want)
		}
	}
	mac := ClaudeSources("darwin", "/Users/a", map[string]string{"CLAUDE_CONFIG_DIR": "/cfg"})
	if !strings.HasPrefix(mac[0].Service, "Claude Code-credentials-") || len(mac[0].Service) != len("Claude Code-credentials-")+8 {
		t.Errorf("按目录派生的钥匙串项不对：%q", mac[0].Service)
	}
}

func TestPlans(t *testing.T) {
	for in, want := range map[[2]string]string{{"max", "default_claude_max_5x"}: "Max 5x", {"pro", ""}: "Pro", {"", "x"}: ""} {
		if got := ClaudePlan(in[0], in[1]); got != want {
			t.Errorf("ClaudePlan%v=%q", in, got)
		}
	}
	for in, want := range map[string]string{"prolite": "Pro 5x", "pro": "Pro 20x", "plus": "Plus", "team_plan": "Team Plan"} {
		if got := CodexPlan(in); got != want {
			t.Errorf("CodexPlan(%s)=%q", in, got)
		}
	}
}

func TestMapUsage(t *testing.T) {
	var claude map[string]any
	json.Unmarshal([]byte(`{"five_hour":{"utilization":12,"resets_at":"2026-09-29T10:00:00Z"},"seven_day":{"utilization":40.5},
		"limits":[{"kind":"weekly_scoped","percent":7,"scope":{"model":{"display_name":"Opus 5"}}},{"kind":"other","percent":1}]}`), &claude)
	ws := MapClaudeUsage(claude)
	if len(ws) != 3 || ws[0].ID != "session" || ws[1].Used != 40.5 || ws[2].ID != "scoped-opus-5" || ws[2].Period != week {
		t.Fatalf("claude 窗口：%+v", ws)
	}
	if MapClaudeUsage(map[string]any{"x": 1}) != nil {
		t.Error("认不出的结构应为 nil")
	}
	var codex map[string]any
	// 只剩周限额时出现在 primary：按时长归到周。
	json.Unmarshal([]byte(`{"rate_limit":{"primary_window":{"used_percent":30,"limit_window_seconds":604800,"reset_after_seconds":60}}}`), &codex)
	ws = MapCodexUsage(codex, http.Header{}, 1000)
	if len(ws) != 1 || ws[0].ID != "weekly" || ws[0].ResetsAt != 61000 {
		t.Fatalf("codex 窗口：%+v", ws)
	}
	h := http.Header{}
	h.Set("x-codex-primary-used-percent", "55")
	ws = MapCodexUsage(map[string]any{}, h, 0)
	if len(ws) != 1 || ws[0].ID != "session" || ws[0].Used != 55 {
		t.Fatalf("按响应头补：%+v", ws)
	}
	var oc map[string]any
	json.Unmarshal([]byte(`{"usage":{"rolling":{"percent":120},"weekly":{"percent":3},"monthly":{"percent":"4"}}}`), &oc)
	ws = MapOpencodeUsage(oc)
	if len(ws) != 3 || ws[0].Used != 100 || ws[2].Used != 4 {
		t.Fatalf("opencode 窗口：%+v", ws)
	}
	delete(oc["usage"].(map[string]any), "monthly")
	if MapOpencodeUsage(oc) != nil {
		t.Error("缺窗口应为 nil")
	}
}

func jwt(claims map[string]any) string {
	raw, _ := json.Marshal(claims)
	return "h." + base64.RawURLEncoding.EncodeToString(raw) + ".s"
}

// fakeDeps：假文件、假钥匙串、假用量接口。
func fakeDeps(t *testing.T, files map[string]string, handler http.HandlerFunc) Deps {
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	now := time.UnixMilli(1_800_000_000_000)
	return Deps{
		GOOS: "linux", Home: "/home/a", Env: map[string]string{},
		ReadFile: func(p string) ([]byte, error) {
			if v, ok := files[p]; ok {
				if v == "ERR" {
					return nil, errors.New("权限不够")
				}
				return []byte(v), nil
			}
			return nil, nil
		},
		Keychain: func(string, string) (string, error) { return "", nil },
		HTTP:     srv.Client(),
		Now:      func() time.Time { return now },
		URLs:     map[string]string{"claude": srv.URL + "/c", "codex": srv.URL + "/x", "opencode": srv.URL + "/o"},
	}
}

func TestReaders(t *testing.T) {
	const secret = "sk-SECRET-TOKEN"
	future := 1_900_000_000_000
	files := map[string]string{
		"/home/a/.claude/.credentials.json":       `{"claudeAiOauth":{"accessToken":"` + secret + `","expiresAt":` + jsonNum(future) + `,"subscriptionType":"max","rateLimitTier":"max_20x"}}`,
		"/home/a/.claude.json":                    `{"oauthAccount":{"accountUuid":"u-1","organizationUuid":"o-1"}}`,
		"/home/a/.codex/auth.json":                `{"tokens":{"access_token":"` + jwt(map[string]any{"exp": 1_900_000_000}) + `","account_id":"acc","id_token":"` + jwt(map[string]any{"sub": "me"}) + `"}}`,
		"/home/a/.local/share/opencode/auth.json": `{"opencode-go":{"key":"` + secret + `"}}`,
	}
	var seen []string
	d := fakeDeps(t, files, func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Path+" "+r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/c":
			w.Write([]byte(`{"five_hour":{"utilization":10},"seven_day":{"utilization":20}}`))
		case "/x":
			w.Write([]byte(`{"plan_type":"prolite","rate_limit":{"primary_window":{"used_percent":5,"limit_window_seconds":18000}}}`))
		case "/o":
			w.Write([]byte(`{"usage":{"rolling":{"percent":1},"weekly":{"percent":2},"monthly":{"percent":3}}}`))
		}
	})
	for _, a := range Builtin {
		r := ReadAccount(context.Background(), d, a)
		raw, _ := json.Marshal(r)
		if !r.OK || r.Finger == "" || len(r.Finger) != 16 || strings.Contains(string(raw), secret) {
			t.Errorf("%s: %s", a, raw)
		}
	}
	if len(seen) != 3 || seen[0] != "/c Bearer "+secret {
		t.Errorf("请求：%q", seen)
	}
	if r := ReadAccount(context.Background(), d, "claude"); r.Plan != "Max 20x" {
		t.Errorf("套餐：%q", r.Plan)
	}
}

func jsonNum(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestReaderFailures(t *testing.T) {
	status := 200
	body := `{}`
	d := fakeDeps(t, map[string]string{}, func(w http.ResponseWriter, r *http.Request) {
		if status == 429 {
			w.Header().Set("Retry-After", "600")
		}
		w.WriteHeader(status)
		w.Write([]byte(body))
	})
	ctx := context.Background()
	if r := ReadAccount(ctx, d, "claude"); r.OK || !strings.Contains(r.Reason, "没有找到 Claude Code 登录") {
		t.Errorf("没登录：%+v", r)
	}
	d.ReadFile = func(p string) ([]byte, error) {
		switch p {
		case "/home/a/.claude/.credentials.json":
			return []byte(`{"claudeAiOauth":{"accessToken":"tok","expiresAt":1}}`), nil
		case "/home/a/.codex/auth.json":
			return []byte(`{"OPENAI_API_KEY":"k"}`), nil
		case "/home/a/.local/share/opencode/auth.json":
			return []byte(`{"other":{}}`), nil
		case "/home/a/.config/codex/auth.json":
			return nil, errors.New("坏了")
		}
		return nil, nil
	}
	cases := map[string]string{"claude": "登录已过期", "codex": "只用 API key", "opencode": "没有登录 OpenCode Go"}
	if r := ReadAccount(ctx, d, "claude"); strings.Contains(r.Reason, "自动续期") || strings.Contains(r.Reason, "运行 claude") {
		t.Fatalf("过期提示仍许诺 CLI 恢复订阅登录：%s", r.Reason)
	}
	for a, want := range cases {
		if r := ReadAccount(ctx, d, a); r.OK || !strings.Contains(r.Reason, want) {
			t.Errorf("%s: %+v", a, r)
		}
	}
	d.ReadFile = func(p string) ([]byte, error) {
		if p == "/home/a/.claude/.credentials.json" {
			return []byte(`{"claudeAiOauth":{"accessToken":"tok"}}`), nil
		}
		if p == "/home/a/.local/share/opencode/auth.json" {
			return []byte(`{"opencode-go":{"key":"k"}}`), nil
		}
		return nil, nil
	}
	status = 429
	r := ReadAccount(ctx, d, "claude")
	if r.OK || r.retryAt != d.Now().UnixMilli()+600_000 {
		t.Errorf("限流：%+v", r)
	}
	status, body = 403, `{"error":{"type":"EntitlementError"}}`
	if r := ReadAccount(ctx, d, "opencode"); r.Reason != "没有 OpenCode Go 订阅" {
		t.Errorf("没订阅：%+v", r)
	}
	status, body = 200, `{"weird":1}`
	if r := ReadAccount(ctx, d, "claude"); r.Reason != "Claude 用量接口返回的结构认不出" {
		t.Errorf("结构变了：%+v", r)
	}
}

func TestLocalCache(t *testing.T) {
	calls := 0
	d := fakeDeps(t, map[string]string{"/home/a/.local/share/opencode/auth.json": `{"opencode-go":{"key":"k"}}`},
		func(w http.ResponseWriter, r *http.Request) {
			calls++
			w.Write([]byte(`{"usage":{"rolling":{"percent":1},"weekly":{"percent":2},"monthly":{"percent":3}}}`))
		})
	now := time.UnixMilli(1_800_000_000_000)
	d.Now = func() time.Time { return now }
	l := NewLocal(d)
	if got := l.Due(context.Background(), nil); len(got) != 3 {
		t.Fatalf("第一次应读三家：%d", len(got))
	}
	if got := l.Due(context.Background(), nil); len(got) != 0 {
		t.Fatalf("缓存内不该再读：%d", len(got))
	}
	now = now.Add(61 * time.Second) // 失败的（claude、codex 没登录）1 分钟后再读，读到的 5 分钟
	if got := l.Due(context.Background(), nil); len(got) != 2 {
		t.Fatalf("1 分钟后只重读失败的两家：%d", len(got))
	}
	now = now.Add(5 * time.Minute)
	if got := l.Due(context.Background(), nil); len(got) != 3 || calls != 2 {
		t.Fatalf("5 分钟后都到期：%d，请求 %d 次", len(got), calls)
	}
}

func TestPace(t *testing.T) {
	now := int64(1_800_000_000_000)
	// 周窗 7 天过了一半，已用 30%：富余 20。
	r := Reading{Account: "claude", ReadAt: now, Windows: []Window{
		{ID: "session", Label: "Session", Used: 80, Period: 5 * hour},
		{ID: "weekly", Label: "Weekly", Used: 30, ResetsAt: now + week*500, Period: week},
	}}
	p := PaceOf(r, now)
	if *p.UsedPercent != 30 || *p.ElapsedPct != 50 || *p.SparePercent != 20 || *p.ShortUsedPct != 80 || *p.HoursToReset != 84 || p.Stale {
		t.Fatalf("%+v", p)
	}
	// 零用量、没有重置时刻：周期进度留空。
	r.Windows[1].Used = 0
	if p := PaceOf(r, now); p.ElapsedPct != nil || p.SparePercent != nil {
		t.Error("零用量应留空")
	}
	if p := PaceOf(r, now+11*60_000); !p.Stale {
		t.Error("超过 10 分钟应为旧数")
	}
	if round1(-0.04) != 0 || round1(1.25) != 1.3 {
		t.Error("round1")
	}
}

func TestMergeHosts(t *testing.T) {
	now := int64(10 * lastGood)
	good := func(host, fp string, at int64) Stored {
		return Stored{Host: host, Reading: Reading{Account: "claude", OK: true, Finger: fp, ReadAt: at,
			Windows: []Window{{ID: "weekly", Used: 10, Period: week}}}}
	}
	bad := func(host string, at int64) Stored {
		return Stored{Host: host, Reading: Reading{Account: "claude", Reason: "限流", ReadAt: at}}
	}
	cases := []struct {
		name       string
		rows       []Stored
		from, note string
	}{
		{"本机优先", []Stored{good("h2", "B", now), good("h1", "A", now-100)}, "h1", "h2 的来源读数未合入摘要（账号/共享池关系未知）"},
		{"本机没有取远程", []Stored{good("h2", "B", now)}, "h2", "读自 h2"},
		{"本机失败沿用上次", []Stored{good("h1", "A", now-100), bad("h1", now)}, "h1", "本次读不到（限流），沿用上次读数"},
		{"太旧不用", []Stored{good("h1", "A", now-lastGood-1), bad("h1", now)}, "", "读不到：限流"},
		{"只有远程失败", []Stored{bad("h3", now)}, "", "读不到：限流（h3）"},
	}
	for _, c := range cases {
		l := mergeHosts(c.rows, "h1", now)["claude"]
		if l.From != c.from || l.Note != c.note {
			t.Errorf("%s: from=%q note=%q", c.name, l.From, l.Note)
		}
	}
}

func TestLinesAndSpare(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	builtin := map[string]Line{
		"claude": {Pace: Pace{Account: "claude", UsedPercent: f(50), SparePercent: f(10)}, Source: "builtin"},
		"codex":  {Pace: Pace{Account: "codex"}, Source: "builtin", Note: "读不到：没有找到 Codex 登录"},
	}
	oq := []Pace{{Account: "codex", UsedPercent: f(90), SparePercent: f(-5)}, {Account: "kimi", UsedPercent: f(10), SparePercent: f(30)}, {Account: "claude", UsedPercent: f(1)}}
	lines := Lines(builtin, oq)
	var order []string
	byAcct := map[string]Line{}
	for _, l := range lines {
		order = append(order, l.Account)
		byAcct[l.Account] = l
	}
	if !reflect.DeepEqual(order[:3], []string{"kimi", "claude", "codex"}) || len(lines) != len(Accounts) {
		t.Fatalf("排序：%v", order)
	}
	if byAcct["claude"].Source != "builtin" || byAcct["codex"].Source != "openquota" || byAcct["codex"].Note != "自带读不到：没有找到 Codex 登录" {
		t.Errorf("来源：%+v %+v", byAcct["claude"], byAcct["codex"])
	}
	if byAcct["cursor"].Note != "没有额度数据" {
		t.Error("缺数据行不对")
	}
	// 富余就是 quota 一览里那一行的富余（同一个数）；能不能派另看给用户留的份额。
	cases := []struct {
		acct  string
		spare *float64
		stop  string
	}{{"claude", f(10), ""}, {"codex", f(-5), "额度见底：账号 codex 已用 90.0%，须给用户留 20%"},
		{"kimi", f(30), ""}, {"cursor", nil, ""}}
	for _, c := range cases {
		s := SpareOf(byAcct[c.acct], 20)
		if !reflect.DeepEqual(s.Percent, c.spare) || s.Percent != byAcct[c.acct].SparePercent || s.Stop != c.stop {
			t.Errorf("%s: %+v", c.acct, s)
		}
	}
	for _, c := range []struct {
		name string
		l    Line
		stop bool
	}{
		{"已用正好到留给用户的线", Line{Pace: Pace{Account: "claude", UsedPercent: f(80)}}, true},
		{"差一点", Line{Pace: Pace{Account: "claude", UsedPercent: f(79.9)}}, false},
		{"短窗用光", Line{Pace: Pace{Account: "claude", UsedPercent: f(10), ShortUsedPct: f(100)}}, true},
	} {
		if s := SpareOf(c.l, 20); (s.Stop != "") != c.stop {
			t.Errorf("%s：%+v", c.name, s)
		}
	}
}

func TestRecordAndLast(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	now := store.Now()
	w := []Window{{ID: "weekly", Used: 40, Period: week}}
	// 相同/不同指纹都按机器保留，不能证明账号或套餐关系。
	if err := Record(ctx, db, "h1", []Reading{{Account: "claude", OK: true, Finger: "A", ReadAt: now - 1000, Windows: w}}); err != nil {
		t.Fatal(err)
	}
	if err := Record(ctx, db, "h3", []Reading{{Account: "claude", OK: true, Finger: "A", ReadAt: now, Windows: w}}); err != nil {
		t.Fatal(err)
	}
	if err := Record(ctx, db, "h2", []Reading{{Account: "claude", OK: true, Finger: "B", ReadAt: now, Windows: w},
		{Account: "codex", Reason: "没有找到 Codex 登录", ReadAt: now}}); err != nil {
		t.Fatal(err)
	}
	if Record(ctx, db, "h2", []Reading{{Account: "bogus"}}) == nil {
		t.Error("不认识的账号应拒绝")
	}
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM quota_cache`).Scan(&n)
	if n != 4 {
		t.Errorf("应有 4 行（各机器来源与 codex 失败），得 %d", n)
	}
	// h2 正常刷新换来源指纹，只替换该机器行。
	Record(ctx, db, "h2", []Reading{{Account: "claude", OK: true, Finger: "A", ReadAt: now + 1, Windows: w}})
	db.QueryRow(`SELECT COUNT(*) FROM quota_cache WHERE tool = 'claude'`).Scan(&n)
	if n != 3 {
		t.Errorf("换来源后其他机器两行仍保留，共 3 行，得 %d", n)
	}
	db.Exec(`INSERT INTO quota_settings (name, value) VALUES ('reserve_percent', 50)`)
	env := &app.Env{DB: db, Paths: config.Paths{Data: t.TempDir()}}
	// 隔离实例没有后台读取，一览只摆存下的读数。
	if err := loop(ctx, env); err != nil {
		t.Fatal(err)
	}
	ov, err := Last(ctx, env)
	if err != nil {
		t.Fatal(err)
	}
	spares := map[string]Spare{}
	for _, l := range ov.Lines {
		spares[l.Account] = SpareOf(l, ov.Reserve)
	}
	if ov.Reserve != 50 || spares["claude"].Stop != "" || spares["claude"].Stale || len(ov.Notes) != 1 {
		t.Fatalf("%+v %+v", ov, spares)
	}
	if !strings.Contains(Format(ov), "claude") {
		t.Error("Format")
	}
}

// 后台读取：本机自带读数与 OpenQuota 都存进库，重启后（新的读取器）一览照样有；OpenQuota 到期才再跑。
func TestPoller(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	env := &app.Env{DB: db, Paths: config.Paths{Data: t.TempDir()}}
	d := fakeDeps(t, map[string]string{"/home/a/.local/share/opencode/auth.json": `{"opencode-go":{"key":"k"}}`},
		func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(`{"usage":{"rolling":{"percent":1},"weekly":{"percent":2},"monthly":{"percent":3}}}`))
		})
	now := time.UnixMilli(1_800_000_000_000)
	d.Now = func() time.Time { return now }
	used := 30.0
	runs := 0
	var oqErr error
	p := &poller{local: NewLocal(d), now: d.Now, oq: func(context.Context) ([]Pace, error) {
		runs++
		if oqErr != nil {
			return nil, oqErr
		}
		return []Pace{{Account: "kimi", UsedPercent: &used}}, nil
	}}
	line := func(acct string) Line {
		ov, err := Last(ctx, env)
		if err != nil {
			t.Fatal(err)
		}
		for _, l := range ov.Lines {
			if l.Account == acct {
				return l
			}
		}
		t.Fatalf("没有 %s", acct)
		return Line{}
	}
	if err := p.round(ctx, db); err != nil {
		t.Fatal(err)
	}
	if l := line("opencode"); l.Source != "builtin" || l.UsedPercent == nil {
		t.Errorf("自带读数应存下：%+v", l)
	}
	// 服务重启：内存里什么都没有，一览仍有 OpenQuota 的读数。
	if l := line("kimi"); l.Source != "openquota" || l.UsedPercent == nil || *l.UsedPercent != 30 {
		t.Errorf("OpenQuota 读数应落盘：%+v", l)
	}
	now = now.Add(time.Minute)
	p.round(ctx, db)
	if runs != 1 {
		t.Errorf("OpenQuota 5 分钟内不该再跑：%d 次", runs)
	}
	now = now.Add(okTTL)
	oqErr = errors.New("OpenQuota 读取失败")
	if err := p.round(ctx, db); err != nil || runs != 2 {
		t.Fatalf("到期应再跑：%v %d", err, runs)
	}
	ov, _ := Last(ctx, env)
	if len(ov.Notes) != 2 || ov.Notes[0] != "OpenQuota 读取失败" || line("kimi").Source != "openquota" {
		t.Errorf("读不到时写原因：%+v", ov.Notes)
	}
	// OpenQuota 那一行不混进各台读数。
	all, err := stored(ctx, db)
	if err != nil || len(all) != 3 {
		t.Errorf("各台读数应是三家自带：%v %d", err, len(all))
	}
}

func TestFormatNoData(t *testing.T) {
	used := 40.0
	ov := Overview{Reserve: 20, Lines: []Line{
		{Pace: Pace{Account: "claude", UsedPercent: &used}},
		{Pace: Pace{Account: "kimi"}},
		{Pace: Pace{Account: "grok"}, Note: "没登录"},
	}}
	out := Format(ov)
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(l) == "" || strings.TrimSpace(l) == "kimi" {
			t.Errorf("不该有空行或只有账号名的行：\n%s", out)
		}
	}
	if !strings.Contains(out, "没有额度数据：kimi、grok（没登录）") || !strings.Contains(out, "claude") {
		t.Errorf("没数据的应汇成一行：\n%s", out)
	}
}
