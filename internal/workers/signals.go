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
	SignalQuota     = "quota"     // 额度用尽：标记「工具+模型@机器」到恢复时刻，重新排队
	SignalTransient = "transient" // 供应商或网络临时错误：同一执行者重试一次，再换人一次
	SignalThinking  = "thinking"  // 思考耗尽单次输出：换执行者一次
	SignalSetup     = "setup"     // 工具在这台机器上起不来（没登录、缺运行环境）：标记「工具@机器」，重新排队
	SignalModel     = "model"     // 工具不认这个模型名：标记「工具+模型@机器」，重新排队
)

// Signal 是从退出码与日志尾巴判出来的信号。
type Signal struct {
	Kind     string `json:"kind"`
	Reason   string `json:"reason,omitempty"`
	Evidence string `json:"evidence,omitempty"`
	ResetAt  int64  `json:"reset_at,omitempty"` // 额度恢复时刻（Unix 毫秒）；0 表示报文没写
}

var timeNow = time.Now

// ExitUnknown：接管的进程（服务重启后）拿不到退出码。
const ExitUnknown = -1

// TailBytes 是判信号时读的日志末尾长度。
const TailBytes = 64 * 1024

// Tail 读文件末尾最多 n 字节。
func Tail(path string, n int64) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", err
	}
	off := max(st.Size()-n, 0)
	buf := make([]byte, st.Size()-off)
	_, err = f.ReadAt(buf, off)
	return string(buf), err
}

// LastProgress 是执行者最后一次有输出的时刻（日志修改时间）：有输出即活着。watch 用它判卡死。
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

var (
	errorWordRE = regexp.MustCompile(`(?i)\b(?:error|failed|limit reached|limit exceeded|too many requests|usage limits? will reset|spend(?:ing)? limit)\b|HTTP/\S+ 429|额度.{0,20}(?:用尽|不足|超限)|余额不足`)
	quotaMarkRE = regexp.MustCompile(`(?i)(?:usage|session|rate|request|monthly|daily|5[-_\s]?hour)[\s_]+limits?\s+(?:reached|exceeded|hit|exhausted)|exhausted your quota|RESOURCE_EXHAUSTED|hit (?:your|the) [^\n]{0,40}limits?|usage limits? will reset|set (?:a|your) spend(?:ing)? limit|rate_limit_error|(?:insufficient|exceeded|exhausted)[_\s]+quota|quota[_\s]+(?:exceeded|exhausted|limit|depleted)|too many requests|(?:额度|用量|余额)[^\n]{0,20}(?:用尽|不足|超限|达到上限|已满)`)
	setups      = []struct {
		re     *regexp.Regexp
		reason string
	}{
		{regexp.MustCompile(`(?i)\bnot (?:signed|logged) in\b|please (?:run /login|log ?in|sign ?in)\b|\blogin[_ ]required\b|\brequires? (?:a )?login\b`), "没登录"},
		// 工具或它依赖的解释器找不到：版本管理器没选版本、shell／Windows 找不到命令、shebang 的 env 找不到、拉起子进程 ENOENT
		{regexp.MustCompile(`(?i)No active Node\.js version|\bcommand not found\b|^\S*sh: (?:\d+: )?\S+: not found$|不是内部或外部命令|is not recognized as an internal or external command|^env: \S+: No such file or directory|\bspawn \S+ ENOENT\b|executable file not found in`), "缺运行环境"},
	}
	modelNameRE  = regexp.MustCompile(`(?i)issue with the selected model|\bmodel\b[^\n]{0,40}\b(?:not found|does not exist|is not supported)|\b(?:unknown|invalid|unsupported) model\b|ModelNotFound`)
	retryHintRE  = regexp.MustCompile(`(?i)retry-after|try again in|resets? \d`)
	rateStatusRE = regexp.MustCompile(`(?i)^(rejected|blocked|limited|rate_limited|exceeded|denied)$`)
	http429RE    = regexp.MustCompile(`(?:^|[^\d.])429(?:[^\d]|$)`)
	minutesRE    = regexp.MustCompile(`(?i)try again in ~?\s*(\d+)\s*min`)
	retryRE      = regexp.MustCompile(`(?i)retry-after:\s*(\d+)`)
	resetsInRE   = regexp.MustCompile(`(?i)resets? in\s+((?:\d+\s*[hms]\s*)+)`)
	resetsRE     = regexp.MustCompile(`(?i)resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^()]{2,64})\))?`)
	transients   = []struct {
		re   *regexp.Regexp
		kind string
	}{
		{regexp.MustCompile(`(?i)certificate verif|unable to (?:get|verify) (?:local issuer )?certificate|self[- ]signed certificate|\bCERT_[A-Z_]+\b`), "证书校验出错"},
		{regexp.MustCompile(`(?i)\bE(?:CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|PIPE|AI_AGAIN|NOTFOUND|NETUNREACH|HOSTUNREACH)\b|socket hang up|connection (?:reset|refused)|stream disconnected|network error`), "网络连接出错"},
		{regexp.MustCompile(`(?i)fetch failed`), "网络请求失败"},
		{regexp.MustCompile(`(?i)overloaded`), "供应商过载"},
		{regexp.MustCompile(`(?i)\b(?:HTTP|status(?:\s*code)?|error\s*code)\s*[:=]?\s*5\d\d\b|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout`), "供应商服务端错误（5xx）"},
	}
)

// errorReport 是日志尾巴里最后一段报错：只取执行者的出错事件或非 JSON 的报错行，不扫助手正文与工具内容。
// 之后有一轮正常收尾的，更早的报错已被越过。
func errorReport(tail string) string {
	last := ""
	for _, line := range strings.Split(tail, "\n") {
		e := parseEvent(line)
		if e == nil {
			if errorWordRE.MatchString(line) {
				last = strings.TrimSpace(line)
			} else if last != "" && retryHintRE.MatchString(line) {
				last += "\n" + strings.TrimSpace(line)
			}
			continue
		}
		typ := e.str("type")
		switch {
		case typ == "result" && e["is_error"] == false, typ == "turn.completed":
			last = ""
		case e.str("event") == "result":
			r := e.obj("result")
			if r.str("status") == "SUCCESS" {
				last = ""
			} else if msg := r.str("error"); msg != "" {
				last = msg
			}
		case typ == "rate_limit_event":
			if s := e.obj("rate_limit_info").str("status"); rateStatusRE.MatchString(s) {
				last = "rate limit exceeded: " + s
			}
		case typ == "error" || typ == "turn.failed" || (typ == "result" && e["is_error"] == true):
			var parts []string
			for _, k := range []string{"error", "message", "result", "subtype"} {
				switch v := e[k].(type) {
				case string:
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
			if len(parts) > 0 {
				last = strings.Join(parts, ": ")
			}
		}
	}
	return last
}

func oneLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > 200 {
		return string(r[:200]) + "…"
	}
	return s
}

// Classify 判执行者退出时的信号（纯函数）：先额度用尽，再思考耗尽，再起不来（没登录、缺运行环境）、模型名无效，最后供应商临时错误。
// 退出码 0 不判额度、起不来、模型名无效与临时错误（跑完了就交关卡）；ExitUnknown 不判后三种。
func Classify(exitCode int, tail string, now time.Time) Signal {
	report := errorReport(tail)
	if exitCode != 0 && report != "" && (quotaMarkRE.MatchString(report) || http429RE.MatchString(report)) {
		s := Signal{Kind: SignalQuota, Reason: "额度用尽", Evidence: oneLine(report)}
		if t, ok := resetAt(report, now); ok {
			s.ResetAt = t.UnixMilli()
			s.Reason = "额度用尽，" + t.Local().Format("01-02 15:04") + " 恢复"
		}
		return s
	}
	if s, ok := thinkingExhausted(tail); ok {
		return s
	}
	if exitCode != 0 && exitCode != ExitUnknown {
		plain := ""
		if !endedOK(tail) {
			plain = lastPlainLines(tail, 12)
		}
		for _, text := range []string{report, plain} {
			for _, st := range setups {
				if line := matchLine(st.re, text); line != "" {
					return Signal{Kind: SignalSetup, Reason: st.reason, Evidence: oneLine(line)}
				}
			}
			if modelNameRE.MatchString(text) {
				return Signal{Kind: SignalModel, Reason: "模型名无效", Evidence: oneLine(text)}
			}
		}
		text := report
		if text == "" {
			text = plain
		}
		for _, t := range transients {
			if t.re.MatchString(text) {
				return Signal{Kind: SignalTransient, Reason: "供应商或网络临时错误：" + t.kind, Evidence: oneLine(text)}
			}
		}
	}
	return Signal{}
}

// endedOK：日志里最后的收尾事件是正常收尾（之前的报错已被越过）。
func endedOK(tail string) bool {
	lines := strings.Split(tail, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		e := parseEvent(lines[i])
		switch {
		case e == nil:
		case e.str("type") == "result":
			return e["is_error"] == false
		case e.str("event") == "result":
			return e.obj("result").str("status") == "SUCCESS"
		case e.str("type") == "turn.completed", e.str("type") == "turn.failed":
			return e.str("type") == "turn.completed"
		}
	}
	return false
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

// resetAt 从额度报文里取恢复时刻：codex 的「Try again in ~N min」、claude 的「resets 3:50pm (Zone)」、Retry-After 秒数。
func resetAt(text string, now time.Time) (time.Time, bool) {
	if m := minutesRE.FindStringSubmatch(text); m != nil {
		n, _ := strconv.Atoi(m[1])
		return now.Add(time.Duration(n) * time.Minute), n > 0
	}
	if m := resetsInRE.FindStringSubmatch(text); m != nil {
		d, err := time.ParseDuration(strings.Join(strings.Fields(m[1]), ""))
		return now.Add(d), err == nil && d > 0
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
type Ending struct {
	Known  bool   `json:"known"`
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
}

// Ended 按工具的日志结构判结局：stream-json 看最后的 result 事件（codex 看 turn.completed／turn.failed）；通用命令行按 done_match / error_match。
func (a *Driver) Ended(tail string) Ending {
	if a.cli != nil {
		lines := strings.Split(strings.ReplaceAll(tail, "\r\n", "\n"), "\n") // Windows 原生工具的行尾是 CRLF
		if a.cli.ErrorMatch != "" {
			re := regexp.MustCompile(a.cli.ErrorMatch)
			for i := len(lines) - 1; i >= 0; i-- {
				if re.MatchString(lines[i]) {
					return Ending{Known: true, Reason: "日志命中出错标记（error_match）：" + oneLine(lines[i])}
				}
			}
		}
		if a.cli.DoneMatch != "" {
			re := regexp.MustCompile(a.cli.DoneMatch)
			for _, l := range lines {
				if re.MatchString(l) {
					return Ending{Known: true, OK: true}
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
		e := parseEvent(lines[i])
		switch {
		case e == nil:
		case e.str("type") == "result":
			if e["is_error"] == true {
				return Ending{Known: true, Reason: "执行者报错收尾：" + oneLine(e.str("result")+" "+e.str("subtype"))}
			}
			return Ending{Known: true, OK: true}
		case e.str("event") == "result":
			r := e.obj("result")
			if r.str("status") == "SUCCESS" {
				return Ending{Known: true, OK: true}
			}
			return Ending{Known: true, Reason: "执行者报错收尾：" + oneLine(r.str("status")+" "+r.str("error"))}
		case e.str("type") == "turn.completed":
			return Ending{Known: true, OK: true}
		case e.str("type") == "turn.failed":
			return Ending{Known: true, Reason: "执行者报错收尾：" + oneLine(e.obj("error").str("message"))}
		case e.str("type") == "step_finish":
			if r := e.obj("part").str("reason"); r == "length" {
				return Ending{Known: true, Reason: "上下文或输出长度用尽"}
			}
			return Ending{Known: true, OK: true}
		}
	}
	return Ending{}
}

func asMap(v any) map[string]any { m, _ := v.(map[string]any); return m }

// maxReply 是记下的最后回复的上限（字符）。
const maxReply = 8000

// LastReply 取执行者最后一条回复（纯函数）：stream-json 取收尾事件的 result（agy 取 response），
// opencode 取最后一段文字，codex 取最后一条 agent_message；文本日志取末尾若干行。gates 从这里读审阅结论。
func (a *Driver) LastReply(tail string) string {
	lines := strings.Split(strings.TrimRight(tail, "\n"), "\n")
	if a.JSON {
		for i := len(lines) - 1; i >= 0; i-- {
			e := parseEvent(lines[i])
			switch {
			case e == nil:
			case e.str("type") == "result":
				return clip(e.str("result"))
			case e.str("event") == "result":
				return clip(e.obj("result").str("response"))
			case e.str("type") == "text":
				return clip(e.obj("part").str("text"))
			case e.str("type") == "item.completed" && e.obj("item").str("type") == "agent_message":
				return clip(e.obj("item").str("text"))
			}
		}
		return ""
	}
	if len(lines) > 60 {
		lines = lines[len(lines)-60:]
	}
	return clip(strings.Join(lines, "\n"))
}

func clip(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > maxReply {
		return "…" + string(r[len(r)-maxReply:])
	}
	return s
}
