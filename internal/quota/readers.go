package quota

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Window 是一个额度窗口（会话、周、月、模型专属……），只收百分比口径。
type Window struct {
	ID       string  `json:"id"`
	Label    string  `json:"label"`
	Used     float64 `json:"used"`      // 0–100
	ResetsAt int64   `json:"resets_at"` // 毫秒；0 为不知道
	Period   int64   `json:"period"`    // 秒；0 为不知道或不按固定周期
}

// Reading 是一台机器对一个账号的一次读数。只含数字、套餐名与账号指纹，不含令牌。
type Reading struct {
	Account string   `json:"account"` // claude、codex、opencode
	OK      bool     `json:"ok"`
	Reason  string   `json:"reason,omitempty"` // 读不到的原因（固定中文句子，不带令牌或响应正文）
	Plan    string   `json:"plan,omitempty"`
	Windows []Window `json:"windows,omitempty"`
	ReadAt  int64    `json:"read_at"`
	Finger  string   `json:"finger,omitempty"` // 账号指纹：sha256(<账号>:<id>) 前 16 位
	retryAt int64
}

// Deps 是读取器用到的外部依赖；测试全部换成假的。
type Deps struct {
	GOOS string
	Home string
	Env  map[string]string
	// ReadFile 读文件；不存在返回 nil, nil。
	ReadFile func(path string) ([]byte, error)
	// Keychain 读 macOS 钥匙串通用密码；没有该项返回 "", nil。
	Keychain func(service, account string) (string, error)
	HTTP     *http.Client
	Now      func() time.Time
	// URLs 覆盖用量接口地址（测试用）；键为账号。
	URLs map[string]string
}

// 用量接口。只读：不改、不刷新对方凭据，令牌过期只报「登录已过期」。
var usageURL = map[string]string{
	"claude":   "https://api.anthropic.com/api/oauth/usage",
	"codex":    "https://chatgpt.com/backend-api/wham/usage",
	"opencode": "https://opencode.ai/zen/go/v1/usage",
}

// Builtin 是自带读取覆盖的账号。
var Builtin = []string{"claude", "codex", "opencode"}

func (d Deps) url(account string) string {
	if u := d.URLs[account]; u != "" {
		return u
	}
	return usageURL[account]
}

// ReadAccount 读一个自带账号的额度。
func ReadAccount(ctx context.Context, d Deps, account string) Reading {
	var r Reading
	switch account {
	case "claude":
		r = readClaude(ctx, d)
	case "codex":
		r = readCodex(ctx, d)
	case "opencode":
		r = readOpencode(ctx, d)
	default:
		r = Reading{Reason: "没有自带读取"}
	}
	r.Account = account
	r.ReadAt = d.Now().UnixMilli()
	return r
}

func fail(reason string) Reading { return Reading{Reason: reason} }

// fingerprint：账号 id 的不可逆指纹；多台机器读到同一指纹算同一个账号。
func fingerprint(account, id string) string {
	sum := sha256.Sum256([]byte(account + ":" + id))
	return hex.EncodeToString(sum[:])[:16]
}

const maxCredential = 1 << 20

// firstCredential 按顺序找第一份可用凭据；parse 返回 false 表示这份不可用。
func firstCredential[T any](d Deps, sources []Source, parse func([]byte) (T, bool)) (T, Source, bool, bool) {
	var zero T
	unreadable := false
	for _, s := range sources {
		var raw []byte
		var err error
		if s.File != "" {
			raw, err = d.ReadFile(s.File)
		} else if d.Keychain != nil {
			var text string
			text, err = d.Keychain(s.Service, s.Account)
			if text != "" {
				raw = []byte(text)
			}
		}
		if err != nil || len(raw) > maxCredential {
			unreadable = true
			continue
		}
		if raw == nil {
			continue
		}
		v, ok := parse(raw)
		if !ok {
			unreadable = true
			continue
		}
		return v, s, true, false
	}
	return zero, Source{}, false, unreadable
}

// jsonDoc 解析 JSON，或十六进制编码的 JSON（钥匙串里有时这样存）。
func jsonDoc(raw []byte) map[string]any {
	var m map[string]any
	if json.Unmarshal(raw, &m) == nil {
		return m
	}
	b, err := hex.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || json.Unmarshal(b, &m) != nil {
		return nil
	}
	return m
}

func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func str(v any) string         { s, _ := v.(string); return strings.TrimSpace(s) }

// num 取数字或数字字符串。
func num(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, !math.IsNaN(x) && !math.IsInf(x, 0)
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil && !math.IsInf(f, 0)
	}
	return 0, false
}

// timeOf：ISO 时间串（无时区按 UTC）、秒或毫秒时间戳 → 毫秒；认不出为 0。
func timeOf(v any) int64 {
	if s, ok := v.(string); ok {
		if _, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err != nil {
			for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02T15:04:05"} {
				if t, err := time.Parse(layout, strings.TrimSpace(s)); err == nil {
					return t.UnixMilli()
				}
			}
			return 0
		}
	}
	f, ok := num(v)
	if !ok {
		return 0
	}
	if math.Abs(f) < 1e10 {
		f *= 1000
	}
	return int64(math.Round(f))
}

// jwtClaims 解 JWT 载荷（只解码，不校验签名）。
func jwtClaims(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil
	}
	var m map[string]any
	json.Unmarshal(raw, &m)
	return m
}

type reply struct {
	status int
	header http.Header
	body   map[string]any
}

// getJSON 发只读 GET；失败只给分类，不外传底层报错（可能带请求头）。
func getJSON(ctx context.Context, d Deps, url string, headers map[string]string) (reply, string) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return reply{}, "network"
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	hc := d.HTTP
	if hc == nil {
		hc = &http.Client{}
	}
	client := *hc
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("不跟随跳转") }
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return reply{}, "timeout"
		}
		return reply{}, "network"
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var body map[string]any
	json.Unmarshal(raw, &body)
	return reply{status: resp.StatusCode, header: resp.Header, body: body}, ""
}

func transport(kind, who string) string {
	if kind == "timeout" {
		return who + " 用量接口超时"
	}
	return "连不上 " + who + " 用量接口"
}

// retryAfter：秒数或 HTTP 日期 → 毫秒时刻。
func retryAfter(v string, now int64) int64 {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if n, err := strconv.Atoi(v); err == nil {
		return now + int64(n)*1000
	}
	if t, err := http.ParseTime(v); err == nil {
		return max(now, t.UnixMilli())
	}
	return 0
}

const (
	hour = int64(3600)
	week = 7 * 24 * hour
)

// ---- Claude Code ----

type claudeLogin struct {
	token, sub, tier string
	expires          int64
}

func parseClaude(raw []byte) (claudeLogin, bool) {
	o := obj(jsonDoc(raw)["claudeAiOauth"])
	if o == nil || str(o["accessToken"]) == "" {
		return claudeLogin{}, false
	}
	exp, _ := num(o["expiresAt"])
	return claudeLogin{token: str(o["accessToken"]), sub: str(o["subscriptionType"]), tier: str(o["rateLimitTier"]), expires: int64(exp)}, true
}

// ClaudePlan：「max」+「default_claude_max_5x」→「Max 5x」。
func ClaudePlan(sub, tier string) string {
	if sub == "" {
		return ""
	}
	words := strings.Fields(strings.ToLower(sub))
	for i, w := range words {
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	plan := strings.Join(words, " ")
	for _, part := range strings.FieldsFunc(tier, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9')
	}) {
		if len(part) > 1 && strings.HasSuffix(part, "x") {
			if _, err := strconv.Atoi(part[:len(part)-1]); err == nil {
				return plan + " " + part
			}
		}
	}
	return plan
}

var claudeScoped = map[string]int64{"weekly_scoped": week, "daily_scoped": 24 * hour, "session_scoped": 5 * hour, "five_hour_scoped": 5 * hour}

// MapClaudeUsage：用量响应 → 窗口；一个窗口都没有说明结构变了（返回 nil）。
func MapClaudeUsage(body map[string]any) []Window {
	var out []Window
	for _, k := range []struct {
		key, id, label string
		period         int64
	}{{"five_hour", "session", "Session", 5 * hour}, {"seven_day", "weekly", "Weekly", week}, {"seven_day_sonnet", "sonnet", "Sonnet", week}} {
		if v := obj(body[k.key]); v != nil {
			if used, ok := num(v["utilization"]); ok {
				out = append(out, Window{ID: k.id, Label: k.label, Used: used, ResetsAt: timeOf(v["resets_at"]), Period: k.period})
			}
		}
	}
	limits, _ := body["limits"].([]any)
	for _, l := range limits {
		lim := obj(l)
		kind := str(lim["kind"])
		if !strings.HasSuffix(kind, "_scoped") {
			continue
		}
		label := str(obj(obj(lim["scope"])["model"])["display_name"])
		slug := strings.Join(strings.FieldsFunc(strings.ToLower(label), func(r rune) bool {
			return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r > 0x7f)
		}), "-")
		used, ok := num(lim["percent"])
		if slug == "" || !ok {
			continue
		}
		id := "scoped-" + strings.TrimSuffix(kind, "_scoped") + "-" + slug
		if kind == "weekly_scoped" {
			id = "scoped-" + slug
		}
		period := claudeScoped[kind]
		if p, ok := num(lim["period_seconds"]); ok && p >= 0 {
			period = int64(p)
		}
		out = append(out, Window{ID: id, Label: label, Used: used, ResetsAt: timeOf(lim["resets_at"]), Period: period})
	}
	return out
}

func readClaude(ctx context.Context, d Deps) Reading {
	login, src, ok, unreadable := firstCredential(d, ClaudeSources(d.GOOS, d.Home, d.Env), parseClaude)
	if !ok {
		if unreadable {
			return fail("Claude Code 登录数据读不出，运行 claude 重新登录")
		}
		return fail("没有找到 Claude Code 登录，运行 claude 登录")
	}
	now := d.Now().UnixMilli()
	if login.expires > 0 && login.expires <= now {
		return fail(fmt.Sprintf("Claude Code 登录已过期（%s），运行一次 claude 会自动续期", src))
	}
	r, kind := getJSON(ctx, d, d.url("claude"), map[string]string{
		"Authorization": "Bearer " + login.token, "Accept": "application/json",
		"anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.69",
	})
	switch {
	case kind != "":
		return fail(transport(kind, "Claude"))
	case r.status == 401 || r.status == 403:
		return fail("Claude 用量接口拒绝了登录（令牌失效），运行 claude 重新登录")
	case r.status == 429:
		out := fail("Claude 用量接口限流")
		out.retryAt = retryAfter(r.header.Get("Retry-After"), now)
		if out.retryAt == 0 {
			out.retryAt = now + 5*60_000
		}
		return out
	case r.status < 200 || r.status >= 300:
		return fail(fmt.Sprintf("Claude 用量接口返回 HTTP %d", r.status))
	}
	windows := MapClaudeUsage(r.body)
	if len(windows) == 0 {
		return fail("Claude 用量接口返回的结构认不出")
	}
	out := Reading{OK: true, Plan: ClaudePlan(login.sub, login.tier), Windows: windows}
	if raw, err := d.ReadFile(ClaudeAccountFile(d.GOOS, d.Home, d.Env)); err == nil && raw != nil && len(raw) < 32<<20 {
		acct := obj(jsonDoc(raw)["oauthAccount"])
		if id := str(acct["accountUuid"]); id != "" {
			out.Finger = fingerprint("claude", id+":"+str(acct["organizationUuid"]))
		}
	}
	return out
}

// ---- Codex ----

type codexLogin struct {
	token, accountID, finger string
	apiKeyOnly               bool
}

func parseCodex(raw []byte) (codexLogin, bool) {
	doc := jsonDoc(raw)
	if doc == nil {
		return codexLogin{}, false
	}
	tokens := obj(doc["tokens"])
	if tok := str(tokens["access_token"]); tok != "" {
		l := codexLogin{token: tok, accountID: str(tokens["account_id"])}
		claims := jwtClaims(str(tokens["id_token"]))
		auth := obj(claims["https://api.openai.com/auth"])
		user := ""
		for _, v := range []any{auth["chatgpt_user_id"], auth["user_id"], claims["sub"]} {
			if user = str(v); user != "" {
				break
			}
		}
		if user != "" || l.accountID != "" {
			l.finger = fingerprint("codex", user+":"+l.accountID)
		}
		return l, true
	}
	if str(doc["OPENAI_API_KEY"]) != "" {
		return codexLogin{apiKeyOnly: true}, true
	}
	return codexLogin{}, false
}

// CodexPlan：prolite 是 Pro 5x，pro 是 Pro 20x，其余按下划线分词首字母大写。
func CodexPlan(v string) string {
	switch strings.ToLower(v) {
	case "":
		return ""
	case "prolite":
		return "Pro 5x"
	case "pro":
		return "Pro 20x"
	}
	parts := strings.Split(v, "_")
	for i, p := range parts {
		if p != "" {
			parts[i] = strings.ToUpper(p[:1]) + p[1:]
		}
	}
	return strings.Join(parts, " ")
}

// codexWindows 把 primary/secondary 两个窗口按时长分成会话与周（只剩周限额时它会出现在 primary）。
func codexWindows(rate map[string]any, ids [2][2]string, headers [2]*float64, now int64) []Window {
	const session = 5 * hour
	type cand struct {
		w        map[string]any
		used     *float64
		fallback int
	}
	var cands []cand
	for i, key := range []string{"primary_window", "secondary_window"} {
		w := obj(rate[key])
		if w == nil && headers[i] == nil {
			continue
		}
		c := cand{w: w, used: headers[i], fallback: i}
		if u, ok := num(w["used_percent"]); ok {
			c.used = &u
		}
		cands = append(cands, c)
	}
	exact := func(w map[string]any) int {
		s, _ := num(w["limit_window_seconds"])
		switch int64(s) {
		case session:
			return 0
		case week:
			return 1
		}
		return -1
	}
	var out []Window
	for kind := range 2 {
		var pick *cand
		for i := range cands {
			if exact(cands[i].w) == kind {
				pick = &cands[i]
				break
			}
		}
		if pick == nil {
			for i := range cands {
				if exact(cands[i].w) == -1 && cands[i].fallback == kind {
					pick = &cands[i]
					break
				}
			}
		}
		if pick == nil || pick.used == nil {
			continue
		}
		reset := timeOf(pick.w["reset_at"])
		if after, ok := num(pick.w["reset_after_seconds"]); reset == 0 && ok {
			reset = now + int64(math.Round(after*1000))
		}
		period := []int64{session, week}[kind]
		if p, ok := num(pick.w["limit_window_seconds"]); ok {
			period = max(0, int64(p))
		}
		out = append(out, Window{ID: ids[kind][0], Label: ids[kind][1], Used: *pick.used, ResetsAt: reset, Period: period})
	}
	return out
}

// MapCodexUsage：用量响应 → 窗口（会话、周，另有 Spark 就加上）。
func MapCodexUsage(body map[string]any, h http.Header, now int64) []Window {
	var hdr [2]*float64
	for i, name := range []string{"x-codex-primary-used-percent", "x-codex-secondary-used-percent"} {
		if v, ok := num(h.Get(name)); ok && h.Get(name) != "" {
			hdr[i] = &v
		}
	}
	out := codexWindows(obj(body["rate_limit"]), [2][2]string{{"session", "Session"}, {"weekly", "Weekly"}}, hdr, now)
	extra, _ := body["additional_rate_limits"].([]any)
	for _, e := range extra {
		m := obj(e)
		if strings.Contains(strings.ToLower(str(m["limit_name"])+" "+str(m["metered_feature"])), "spark") {
			out = append(out, codexWindows(obj(m["rate_limit"]), [2][2]string{{"spark", "Spark"}, {"sparkWeekly", "Spark Weekly"}}, [2]*float64{}, now)...)
			break
		}
	}
	return out
}

func readCodex(ctx context.Context, d Deps) Reading {
	login, src, ok, unreadable := firstCredential(d, CodexSources(d.GOOS, d.Home, d.Env), parseCodex)
	if !ok {
		if unreadable {
			return fail("Codex 登录数据读不出，运行 codex 重新登录")
		}
		return fail("没有找到 Codex 登录，运行 codex 用 ChatGPT 账号登录")
	}
	if login.apiKeyOnly {
		return fail("Codex 只用 API key 登录，没有订阅额度；改用 ChatGPT 账号登录")
	}
	now := d.Now().UnixMilli()
	if exp, ok := num(jwtClaims(login.token)["exp"]); ok && int64(exp*1000) <= now {
		return fail(fmt.Sprintf("Codex 登录已过期（%s），运行一次 codex 会自动续期", src))
	}
	headers := map[string]string{"Authorization": "Bearer " + login.token, "Accept": "application/json", "User-Agent": "Atrium"}
	if login.accountID != "" {
		headers["ChatGPT-Account-Id"] = login.accountID
	}
	r, kind := getJSON(ctx, d, d.url("codex"), headers)
	switch {
	case kind != "":
		return fail(transport(kind, "Codex"))
	case r.status == 401 || r.status == 403:
		return fail("Codex 用量接口拒绝了登录（令牌失效），运行 codex 重新登录")
	case r.status < 200 || r.status >= 300:
		return fail(fmt.Sprintf("Codex 用量接口返回 HTTP %d", r.status))
	}
	windows := MapCodexUsage(r.body, r.header, now)
	if len(windows) == 0 {
		return fail("Codex 用量接口返回的结构认不出")
	}
	return Reading{OK: true, Plan: CodexPlan(str(r.body["plan_type"])), Windows: windows, Finger: login.finger}
}

// ---- OpenCode Go ----

// MapOpencodeUsage：rolling、weekly、monthly 三个窗口缺一个就当结构变了。
func MapOpencodeUsage(body map[string]any) []Window {
	usage := obj(body["usage"])
	if usage == nil {
		return nil
	}
	var out []Window
	for _, k := range []struct {
		key, id, label string
		period         int64
	}{{"rolling", "session", "Session", 5 * hour}, {"weekly", "weekly", "Weekly", week}, {"monthly", "monthly", "Monthly", 0}} {
		v := obj(usage[k.key])
		p, ok := num(v["percent"])
		if !ok {
			return nil
		}
		out = append(out, Window{ID: k.id, Label: k.label, Used: min(100, max(0, p)), ResetsAt: timeOf(v["resetsAt"]), Period: k.period})
	}
	return out
}

func readOpencode(ctx context.Context, d Deps) Reading {
	noGo := false
	key, _, ok, unreadable := firstCredential(d, OpencodeSources(d.GOOS, d.Home, d.Env), func(raw []byte) (string, bool) {
		var doc map[string]any
		if json.Unmarshal(raw, &doc) != nil {
			return "", false
		}
		k := str(obj(doc["opencode-go"])["key"])
		if k == "" {
			noGo = true
		}
		return k, k != ""
	})
	if !ok {
		switch {
		case noGo:
			return fail("OpenCode 没有登录 OpenCode Go")
		case unreadable:
			return fail("OpenCode 登录数据读不出，重新登录 OpenCode Go")
		}
		return fail("没有找到 OpenCode 登录，登录 OpenCode Go")
	}
	r, kind := getJSON(ctx, d, d.url("opencode"), map[string]string{"Authorization": "Bearer " + key, "Accept": "application/json", "User-Agent": "Atrium"})
	switch {
	case kind != "":
		return fail(transport(kind, "OpenCode Go"))
	case r.status == 401:
		return fail("OpenCode Go 登录失效或过期，重新登录 OpenCode Go")
	case r.status == 403 && str(obj(r.body["error"])["type"]) == "EntitlementError":
		return fail("没有 OpenCode Go 订阅")
	case r.status < 200 || r.status >= 300:
		return fail(fmt.Sprintf("OpenCode Go 用量接口返回 HTTP %d", r.status))
	}
	windows := MapOpencodeUsage(r.body)
	if windows == nil {
		return fail("OpenCode Go 用量接口返回的结构认不出")
	}
	return Reading{OK: true, Plan: "Go", Windows: windows, Finger: fingerprint("opencode", key)}
}

// ---- 本机依赖 ----

// LocalDeps 是真实的依赖：本机文件、钥匙串（经 /usr/bin/security，只读不弹框的项）、网络。
func LocalDeps(goos, home string, env map[string]string) Deps {
	return Deps{
		GOOS: goos, Home: home, Env: env,
		ReadFile: func(p string) ([]byte, error) {
			b, err := os.ReadFile(p)
			if errors.Is(err, os.ErrNotExist) {
				return nil, nil
			}
			return b, err
		},
		Keychain: keychain(goos, env),
		HTTP:     &http.Client{},
		Now:      time.Now,
	}
}
