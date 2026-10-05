package workers

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// 日志信号的种类。dispatch 在执行者退出时判，watch 也可以拿日志尾巴来判。
const (
	SignalNone      = ""
	SignalQuota     = "quota"     // 额度用尽：标记到报文里的恢复时刻（没写的标恢复时间未知），按已知套餐范围有界换人
	SignalTransient = "transient" // 做过事之后出错退出、原因不是下面几种（供应方临时错误多是这样）：同一执行者重试一次，再换人
	SignalThinking  = "thinking"  // 思考耗尽单次输出：换执行者一次
	SignalSetup     = "setup"     // 工具在这台起不来：标「工具@机器」，有界换人
	SignalModel     = "model"     // 模型无效：标「工具+模型@机器」，有界换人
	SignalNoStart   = "nostart"   // 零步骤出错或完整零 usage 静默空转：保留期内避开，有界换人
)

// Signal 是从退出码与日志尾巴判出来的信号。
type Signal struct {
	Kind     string `json:"kind"`
	Reason   string `json:"reason,omitempty"`
	Evidence string `json:"evidence,omitempty"`
	ResetAt  int64  `json:"reset_at,omitempty"` // 额度恢复时刻（Unix 毫秒）；0 表示报文没写
}

var timeNow = time.Now

// ExitUnknown：继续跟进的进程（服务重启后）拿不到退出码。
const ExitUnknown = -1

// TailBytes 是判信号时读的日志末尾长度。
const TailBytes = 64 * 1024

// LogTail 是日志末尾的整行。Cut：前面还有内容没读（开头截断的半行已丢掉）。
type LogTail struct {
	Text string
	Cut  bool
}

// Tail 读文件末尾最多 n 字节；从中间读起时丢掉开头的半行——半行里可能是工具输出的任意文字，不能当报错行判。
func Tail(path string, n int64) (LogTail, error) {
	f, err := os.Open(path)
	if err != nil {
		return LogTail{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return LogTail{}, err
	}
	off := max(st.Size()-n, 0)
	buf := make([]byte, st.Size()-off)
	if _, err := f.ReadAt(buf, off); err != nil {
		return LogTail{}, err
	}
	if off == 0 {
		return LogTail{Text: string(buf)}, nil
	}
	_, rest, _ := strings.Cut(string(buf), "\n")
	return LogTail{Text: rest, Cut: true}, nil
}

// LastProgress 是执行者最后一次有输出的时刻（日志修改时间）：有输出即活着。watch 用它判长时间没进展。
func LastProgress(logPath string) (time.Time, error) {
	st, err := os.Stat(logPath)
	if err != nil {
		return time.Time{}, err
	}
	return st.ModTime(), nil
}

type event map[string]any

func parseEvent(line string) event {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "{") {
		return nil
	}
	var e event
	if json.Unmarshal([]byte(line), &e) != nil {
		return nil
	}
	return e
}

func (e event) str(k string) string { s, _ := e[k].(string); return s }
func (e event) obj(k string) event  { m, _ := e[k].(map[string]any); return m }

// 额度措辞的两半：limit 只认带限定词的（context、token 之类的 limit 不是额度）；动词前不能紧挨字母（white 里的 hit 不算）。
const (
	quotaNoun = `(?:quota|balances?\b|(?:usage|session|rate|request|monthly|daily|weekly|5[-_\s]?hour|spend(?:ing)?|your)[\s_]+limits?)`
	quotaVerb = `(?:^|[^a-z])(?:reached|exceeded|exhausted|hit|depleted|insufficient)`
)

var (
	errorWordRE = regexp.MustCompile(`(?i)\b(?:error|failed)\b|HTTP/\S+ 429`)
	// quotaMarkRE：额度类名词与「用尽」类动词在同一行、前后任意顺序，外加几种固定说法。
	quotaMarkRE = regexp.MustCompile(`(?i)` + quotaNoun + `[^\n]{0,40}?` + quotaVerb + `|` + quotaVerb + `[^\n]{0,40}?` + quotaNoun +
		`|RESOURCE_EXHAUSTED|rate_limit_error|usage limits? will reset|set (?:a|your) spend(?:ing)? limit|too many requests` +
		`|(?:额度|用量|余额)[^\n]{0,20}(?:用尽|不足|超限|达到上限|已满)`)
	setups = []struct {
		re     *regexp.Regexp
		reason string
	}{
		// 登录失效也算：claude 的 OAuth 过期、被吊销报「Failed to authenticate」，不一定带「请重新登录」；
		// dsh 的默认 provider（DeepSeek）key 失效报「Authentication Fails, Your api key is invalid」。
		{regexp.MustCompile(`(?i)\bnot (?:signed|logged) in\b|please (?:run /login|log ?in|sign ?in)\b|\blogin[_ ]required\b|\brequires? (?:a )?login\b|\bfailed to authenticate\b|\bauthentication fails?\b|\b(?:api[_ ]?key|token)\b[^\n]{0,20}\b(?:is )?(?:invalid|expired|incorrect)\b`), "没登录"},
		// 工具或它依赖的解释器找不到：版本管理器没选版本、shell／Windows 找不到命令、shebang 的 env 找不到、拉起子进程 ENOENT
		{regexp.MustCompile(`(?i)No active Node\.js version|\bcommand not found\b|^\S*sh: (?:\d+: )?\S+: not found$|不是内部或外部命令|is not recognized as an internal or external command|^env: \S+: No such file or directory|\bspawn \S+ ENOENT\b|executable file not found in`), "缺运行环境"},
		// 服务端拒收旧版本：grok 的 426 Upgrade Required「Your Grok CLI version (1.0.5) is outdated」
		{regexp.MustCompile(`(?i)\bUpgrade Required\b|\bversion\b[^\n]{0,40}\bis outdated\b|please update to version`), "工具版本过旧"},
	}
	modelNameRE  = regexp.MustCompile(`(?i)issue with the selected model|\bmodel\b[^\n]{0,40}\b(?:not found|does not exist|is not supported)|\b(?:unknown|invalid|unsupported) model\b|ModelNotFound`)
	retryHintRE  = regexp.MustCompile(`(?i)retry-after|try again in|resets? \d`)
	rateStatusRE = regexp.MustCompile(`(?i)^(rejected|blocked|limited|rate_limited|exceeded|denied)$`)
	http429RE    = regexp.MustCompile(`(?:^|[^\d.])429(?:[^\d]|$)`)
	minutesRE    = regexp.MustCompile(`(?i)try again in ~?\s*(\d+)\s*min`)
	retryRE      = regexp.MustCompile(`(?i)retry-after:\s*(\d+)`)
	resetsInRE   = regexp.MustCompile(`(?i)resets? in\s+((?:\d+\s*[hms]\s*)+)`)
	resetsRE     = regexp.MustCompile(`(?i)resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^()]{2,64})\))?`)
	// codex 402 的绝对日期：「try again at Oct 10th, 2026 9:14 AM」（月份在前，可带序数后缀）；报文没写时区，按本机时区。
	resetDateRE = regexp.MustCompile(`(?i)(?:try again at|will reset at|resets? at)\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?[\s,]+(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)?`)
	// kimi 403 的窗口声明：「reached your 5-hour usage limit … 5-hour window ends」——报文自带窗口长，恢复按窗口算（最晚不早于真实恢复）。
	hoursWindowRE = regexp.MustCompile(`(?i)\b(\d{1,2})[-_ ]?hour (?:usage )?(?:limit|window)`)
)

// monthNames 是报文里英文月名的归一（全名与三字母缩写）。
var monthNames = map[string]time.Month{
	"jan": time.January, "feb": time.February, "mar": time.March, "apr": time.April,
	"may": time.May, "jun": time.June, "jul": time.July, "aug": time.August,
	"sep": time.September, "oct": time.October, "nov": time.November, "dec": time.December,
	"january": time.January, "february": time.February, "march": time.March, "april": time.April,
	"june": time.June, "july": time.July, "august": time.August,
	"september": time.September, "october": time.October, "november": time.November, "december": time.December,
}

// errorReport 是这一轮退出的报错（纯函数）：执行者用自己的出错事件报了错，就以最后一条出错事件为准——
// 之后的非 JSON 行多是工具退出时的收尾噪音（如 codex 的 failed to record rollout items），不能盖掉它；
// 没有出错事件时才取最后一段非 JSON 的报错行。不扫助手正文与工具内容；之后有一轮正常收尾的，更早的报错已被越过。
// tail 要是整行（见 Tail），开头截断的半行不在里面。
func errorReport(tail string) string {
	reported, plain := "", ""
	for _, line := range strings.Split(tail, "\n") {
		e := parseEvent(line)
		if e == nil {
			if errorWordRE.MatchString(line) || quotaMarkRE.MatchString(line) {
				plain = strings.TrimSpace(line)
			} else if plain != "" && retryHintRE.MatchString(line) {
				plain += "\n" + strings.TrimSpace(line)
			}
			continue
		}
		typ := e.str("type")
		switch {
		case typ == "result" && e["is_error"] == false, typ == "turn.completed":
			reported, plain = "", ""
		case e.str("event") == "result":
			r := e.obj("result")
			if r.str("status") == "SUCCESS" {
				reported, plain = "", ""
			} else if msg := r.str("error"); msg != "" {
				reported = msg
			}
		case typ == "status" && e.str("phase") == "turn_end":
			// dsh 的终稿（final）无论成败都写，成败在 turn_end 的 reason 里。
			r := e.obj("reason")
			if r.str("kind") == "completed" {
				reported, plain = "", ""
			} else if msg := oneLine(r.str("kind") + " " + r.obj("error").str("code") + " " + r.obj("error").str("message")); msg != "" {
				reported = msg
			}
		case typ == "rate_limit_event":
			if s := e.obj("rate_limit_info").str("status"); rateStatusRE.MatchString(s) {
				reported = "rate limit exceeded: " + s
			}
		case typ == "error" || typ == "turn.failed" || (typ == "result" && e["is_error"] == true):
			if msg := eventError(e); msg != "" {
				reported = msg
			}
		}
	}
	if reported != "" {
		return reported
	}
	return plain
}

// eventError 拼出一条出错事件里的报文；grok 的报文在 errors 字符串数组里。
// claude 报错收尾的 subtype 常是 success，不是报文，不拼。
func eventError(e event) string {
	var parts []string
	for _, v := range asList(e["errors"]) {
		if s, ok := v.(string); ok {
			parts = append(parts, s)
		}
	}
	for _, k := range []string{"error", "message", "result", "subtype"} {
		switch v := e[k].(type) {
		case string:
			if k == "subtype" && v == "success" {
				continue
			}
			parts = append(parts, v)
		case map[string]any:
			m := event(v)
			for _, f := range []string{"name", "message", "type", "code"} {
				if s := m.str(f); s != "" {
					parts = append(parts, s)
				}
			}
			if s := m.obj("data").str("message"); s != "" {
				parts = append(parts, s)
			}
		}
	}
	return strings.Join(parts, ": ")
}

func oneLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > 200 {
		return string(r[:200]) + "…"
	}
	return s
}

// Classify 判执行者退出时的信号（纯函数）：先额度用尽，再思考耗尽，再起不来（没登录、缺运行环境、工具版本过旧）、模型名无效——这几种换人或等人才过得去，按报文认；
// 其余出错退出不再按措辞分，按行为判：这一轮一步没做的算零步骤出错退出（见 idle），做过事的算临时错误、原地重试。
// worker 是这一轮的执行者标识，数步骤要按它的工具解析日志。
// 出错退出指退出码非 0 且日志最后不是正常收尾；继续跟进拿不到退出码（ExitUnknown）的，日志最后是报错收尾才算。退出码 0 只判思考耗尽（跑完了就进入交付检查）。
func Classify(exitCode int, worker string, log LogTail, now time.Time) Signal {
	tail := log.Text
	report := errorReport(tail)
	if exitCode != 0 {
		if s, ok := quotaSignal(report, now); ok {
			return s
		}
	}
	if s, ok := thinkingExhausted(tail); ok {
		return s
	}
	ended, ok := lastEnding(tail)
	if failed := (ended && !ok) || (!ended && exitCode != ExitUnknown); exitCode == 0 || !failed {
		return Signal{}
	}
	plain := lastPlainLines(tail, 12)
	for _, text := range []string{report, plain} {
		if s, ok := setupSignal(text); ok {
			return s
		}
	}
	text := report
	if text == "" {
		text = plain
	}
	code := "退出码不明"
	if exitCode != ExitUnknown {
		code = fmt.Sprintf("退出码 %d", exitCode)
	}
	if !log.Cut && idle(worker, tail) {
		return Signal{Kind: SignalNoStart, Reason: "零步骤出错退出（" + code + "，原因不明）", Evidence: oneLine(text)}
	}
	return Signal{Kind: SignalTransient, Reason: "做过事之后出错退出（" + code + "），按临时错误重试", Evidence: oneLine(text)}
}

// setupSignal：报文是起不来（没登录、缺运行环境、工具版本过旧）或模型名无效时给出信号。
func setupSignal(text string) (Signal, bool) {
	for _, st := range setups {
		if line := matchLine(st.re, text); line != "" {
			return Signal{Kind: SignalSetup, Reason: st.reason, Evidence: oneLine(line)}, true
		}
	}
	if modelNameRE.MatchString(text) {
		return Signal{Kind: SignalModel, Reason: "模型名无效", Evidence: oneLine(text)}, true
	}
	return Signal{}, false
}

// ReportedSignal 判执行者在自己消息里报、之后没被正常回复盖过的错（Trace.Error）（纯函数）：
// 如 pi 撞了 429 仍以 agent_settled 收尾、退出码 0，Classify 只看退出码非 0 的报文，判不到。报文按 Classify 的同一套规则认，
// 认出额度用尽、起不来或模型名无效才给信号；它是明确的失败证据，不看这一轮有没有产出（产出扫描可能不完整）。
func ReportedSignal(report string, now time.Time) (Signal, bool) {
	if s, ok := quotaSignal(report, now); ok {
		return s, true
	}
	return setupSignal(report)
}

// SilentSignal 是静默空转（见 Silent）且报文认不出（或没报文）时的信号。
func SilentSignal(report string) Signal {
	return Signal{Kind: SignalNoStart, Reason: "静默空转：完整零 usage，且无有效动作或产出", Evidence: oneLine(report)}
}

// quotaSignal：报文是额度用尽时给出信号，读得出恢复时刻的带上。
func quotaSignal(report string, now time.Time) (Signal, bool) {
	if report == "" || !(quotaMarkRE.MatchString(report) || http429RE.MatchString(report)) {
		return Signal{}, false
	}
	s := Signal{Kind: SignalQuota, Reason: "额度用尽", Evidence: oneLine(report)}
	if t, ok := resetAt(report, now); ok {
		s.ResetAt = t.UnixMilli()
		s.Reason = "额度用尽，" + t.Local().Format("01-02 15:04") + " 恢复"
	}
	return s, true
}

// idle：这一轮一步没做——日志里没有一次工具调用，也没说一句话（按 Trace 的分段数）。
// 工具不带解析（通用命令行）的数不出步骤，不算；日志比读到的尾巴长的（LogTail.Cut）由调用方排除。
func idle(worker, tail string) bool {
	if !Traceable(worker) {
		return false
	}
	p := NewParser(worker)
	p.Feed(tail)
	return len(p.t.Segments) == 0
}

// lastEnding：日志里最后的收尾事件，ended 为假表示没有收尾事件；ok 表示正常收尾（之前的报错已被越过）。
func lastEnding(tail string) (ended, ok bool) {
	lines := strings.Split(tail, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		e := parseEvent(lines[i])
		switch {
		case e == nil:
		case e.str("type") == "result":
			return true, e["is_error"] == false
		case e.str("event") == "result":
			return true, e.obj("result").str("status") == "SUCCESS"
		case e.str("type") == "turn.completed", e.str("type") == "turn.failed":
			return true, e.str("type") == "turn.completed"
		case e.str("type") == "status" && e.str("phase") == "turn_end":
			// dsh：终稿（final）跟在后面，但成败看 reason。
			return true, e.obj("reason").str("kind") == "completed"
		}
	}
	return false, false
}

// matchLine 是 text 里第一处命中 re 的那一行；没命中为空。
func matchLine(re *regexp.Regexp, text string) string {
	for _, l := range strings.Split(text, "\n") {
		if re.MatchString(l) {
			return l
		}
	}
	return ""
}

func lastPlainLines(tail string, n int) string {
	var keep []string
	for _, l := range strings.Split(tail, "\n") {
		if l = strings.TrimSpace(l); l != "" && !strings.HasPrefix(l, "{") {
			keep = append(keep, l)
		}
	}
	if len(keep) > n {
		keep = keep[len(keep)-n:]
	}
	return strings.Join(keep, "\n")
}

// resetAt 从额度报文里取恢复时刻：codex 的绝对日期「try again at Oct 10th, 2026 9:14 AM」、
// 「Try again in ~N min」、kimi 的 N 小时窗口、claude 的「resets 3:50pm (Zone)」、Retry-After 秒数。
// 读不出返回 false：报文没写恢复时刻，标记按「恢复时间未知」处理，不按出错时长猜。
func resetAt(text string, now time.Time) (time.Time, bool) {
	if m := resetDateRE.FindStringSubmatch(text); m != nil {
		mon, ok := monthNames[strings.ToLower(m[1])]
		if !ok {
			return time.Time{}, false
		}
		day, _ := strconv.Atoi(m[2])
		year, _ := strconv.Atoi(m[3])
		h, _ := strconv.Atoi(m[4])
		min, _ := strconv.Atoi(m[5])
		switch strings.ToLower(m[6]) {
		case "pm":
			if h != 12 {
				h += 12
			}
		case "am":
			if h == 12 {
				h = 0
			}
		}
		t := time.Date(year, mon, day, h, min, 0, 0, now.Location())
		return t, h < 24 && min < 60 && t.Day() == day && t.After(now)
	}
	if m := minutesRE.FindStringSubmatch(text); m != nil {
		n, _ := strconv.Atoi(m[1])
		return now.Add(time.Duration(n) * time.Minute), n > 0
	}
	if m := resetsInRE.FindStringSubmatch(text); m != nil {
		d, err := time.ParseDuration(strings.Join(strings.Fields(m[1]), ""))
		return now.Add(d), err == nil && d > 0
	}
	if m := hoursWindowRE.FindStringSubmatch(text); m != nil {
		n, _ := strconv.Atoi(m[1])
		return now.Add(time.Duration(n) * time.Hour), n > 0
	}
	if m := resetsRE.FindStringSubmatch(text); m != nil && (m[2] != "" || m[3] != "") {
		h, _ := strconv.Atoi(m[1])
		min, _ := strconv.Atoi(m[2])
		switch strings.ToLower(m[3]) {
		case "pm":
			if h != 12 {
				h += 12
			}
		case "am":
			if h == 12 {
				h = 0
			}
		}
		loc := now.Location()
		if m[4] != "" {
			if l, err := time.LoadLocation(m[4]); err == nil {
				loc = l
			}
		}
		n := now.In(loc)
		t := time.Date(n.Year(), n.Month(), n.Day(), h, min, 0, 0, loc)
		if !t.After(n) {
			t = t.Add(24 * time.Hour)
		}
		return t, h < 24 && min < 60
	}
	if m := retryRE.FindStringSubmatch(text); m != nil {
		n, _ := strconv.Atoi(m[1])
		return now.Add(time.Duration(n) * time.Second), true
	}
	return time.Time{}, false
}

// thinkingExhausted：opencode 最后一步因长度结束（step_finish reason=length），思考用了、正文为 0 或极少。
// 其余工具的日志没有等价信号，不判。
func thinkingExhausted(tail string) (Signal, bool) {
	lines := strings.Split(tail, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		e := parseEvent(lines[i])
		if e == nil || e.str("type") != "step_finish" {
			continue
		}
		part := e.obj("part")
		if part.str("reason") != "length" {
			return Signal{}, false
		}
		tok := part.obj("tokens")
		reasoning, _ := tok["reasoning"].(float64)
		output, _ := tok["output"].(float64)
		if reasoning > 0 && output <= 64 {
			return Signal{Kind: SignalThinking, Reason: fmt.Sprintf("思考耗尽单次输出（思考 %.0f，正文 %.0f）", reasoning, output)}, true
		}
		return Signal{}, false
	}
	return Signal{}, false
}

// Ending 是正常退出后看日志判的结局（纯函数）：Known 为假表示日志判不了，按退出码算。
// Line 是判出结局的那一行日志（收尾事件、命中 done_match／error_match 的行）；通用命令行没见到结束行的推断没有这一行。
type Ending struct {
	Known  bool   `json:"known"`
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
	Line   string `json:"-"`
}

// Ended 按工具的日志结构判结局：stream-json 看最后的 result 事件（codex 看 turn.completed／turn.failed）；通用命令行按 done_match / error_match。
func (a *Driver) Ended(tail string) Ending {
	if a.cli != nil {
		lines := strings.Split(strings.ReplaceAll(tail, "\r\n", "\n"), "\n") // Windows 原生工具的行尾是 CRLF
		if a.cli.ErrorMatch != "" {
			re := regexp.MustCompile(a.cli.ErrorMatch)
			for i := len(lines) - 1; i >= 0; i-- {
				if re.MatchString(lines[i]) {
					return Ending{Known: true, Reason: "日志命中出错标记（error_match）：" + oneLine(lines[i]), Line: lines[i]}
				}
			}
		}
		if a.cli.DoneMatch != "" {
			re := regexp.MustCompile(a.cli.DoneMatch)
			for _, l := range lines {
				if re.MatchString(l) {
					return Ending{Known: true, OK: true, Line: l}
				}
			}
			return Ending{Known: true, Reason: "日志里没见到结束标记（done_match），像是没做完就退出了"}
		}
		return Ending{}
	}
	if !a.JSON {
		return Ending{}
	}
	lines := strings.Split(tail, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if e, ok := eventEnding(parseEvent(lines[i])); ok {
			e.Line = lines[i]
			return e
		}
	}
	return Ending{}
}

// eventEnding 认一条收尾事件；不是收尾事件（或不是 JSON）时 ok 为假。
func eventEnding(e event) (Ending, bool) {
	switch {
	case e == nil:
	case e.str("type") == "result":
		if e["is_error"] == true {
			return Ending{Known: true, Reason: "执行者报错收尾：" + oneLine(e.str("result")+" "+e.str("subtype"))}, true
		}
		if e.str("stopReason") == "permission_denied" {
			return Ending{Known: true, Reason: "工具权限被拒，没干成（permission_denied；--print 下要放行参数）"}, true
		}
		return Ending{Known: true, OK: true}, true
	case e.str("event") == "result":
		r := e.obj("result")
		if r.str("status") == "SUCCESS" {
			return Ending{Known: true, OK: true}, true
		}
		return Ending{Known: true, Reason: "执行者报错收尾：" + oneLine(r.str("status")+" "+r.str("error"))}, true
	case e.str("type") == "turn.completed":
		return Ending{Known: true, OK: true}, true
	case e.str("type") == "turn.failed":
		return Ending{Known: true, Reason: "执行者报错收尾：" + oneLine(e.obj("error").str("message"))}, true
	case e.str("type") == "step_finish":
		if r := e.obj("part").str("reason"); r == "length" {
			return Ending{Known: true, Reason: "上下文或输出长度用尽"}, true
		}
		return Ending{Known: true, OK: true}, true
	case e.str("type") == "agent_settled":
		return Ending{Known: true, OK: true}, true
	case e.str("type") == "auto_retry_end" && e["success"] == false:
		return Ending{Known: true, Reason: "执行者重试耗尽：" + oneLine(e.str("finalError"))}, true
	case e.str("type") == "status" && e.str("phase") == "turn_end":
		// dsh：收尾原因在 reason 里（completed 之外是 aborted、error 等），差错报文在 reason.error。
		r := e.obj("reason")
		if r.str("kind") == "completed" {
			return Ending{Known: true, OK: true}, true
		}
		return Ending{Known: true, Reason: "执行者收尾：" + oneLine(r.str("kind")+" "+r.obj("error").str("code")+" "+r.obj("error").str("message"))}, true
	}
	return Ending{}, false
}

func asMap(v any) map[string]any { m, _ := v.(map[string]any); return m }

func asList(v any) []any { l, _ := v.([]any); return l }
