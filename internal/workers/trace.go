package workers

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// 命令的结局。
const (
	CmdRun  = "run" // 还没结果（在跑）
	CmdOK   = "ok"
	CmdErr  = "err"
	CmdNone = "none" // 搜索类命令（grep、rg）返回 1：没搜到，不算出错
)

const (
	outLines  = 30   // 每条命令留输出的最后几行
	lineRunes = 400  // 输出与原文每行的上限
	cmdRunes  = 4000 // 命令原文的上限
	rawLines  = 40   // 认不出的输出留最后几行
)

// Trace 是一次拉起的「经过」（纯数据）：按执行者自己说的话切段，每段带这段里跑的命令。网页任务抽屉与 task log 共用。
type Trace struct {
	Segments []Segment `json:"segments"`
	Ended    bool      `json:"ended"`            // 走到了收尾
	Result   string    `json:"result,omitempty"` // 收尾总结全文
	Ms       int64     `json:"ms,omitempty"`     // 用时（工具报了才有）
	Lines    []string  `json:"lines,omitempty"`  // 认不出的输出原文（最后 rawLines 行）；解析不了的工具全在这里
}

// Segment 是经过里的一段：执行者说的一句话和它之后跑的命令。Say 为空是开头还没说话的那段。
type Segment struct {
	Say  string    `json:"say"`
	Cmds []Command `json:"cmds,omitempty"`
}

// Command 是一条命令调用，原文不翻译：Bash 是命令本身，其余工具是「工具名 输入」。
type Command struct {
	Cmd   string `json:"cmd"`
	State string `json:"state"`
	Out   string `json:"out,omitempty"` // 输出最后 outLines 行
}

// Traceable：这个执行者（工具[+模型][:强度]）的日志能按段解析；其余工具按原文逐行看。
func Traceable(worker string) bool {
	s, _ := ParseWorker(worker)
	return s.Tool == "claude" || s.Tool == "codex" || s.Tool == "agy"
}

// Parser 逐行读执行者日志攒成 Trace（无 IO）：claude、agy（stream-json）与 codex（exec --json）按事件解析，其余工具逐行留原文。
type Parser struct {
	tool    string
	t       Trace
	open    map[string][2]int // 还没结果的工具调用 → 段、命令下标
	lastSay string
}

func NewParser(worker string) *Parser {
	s, _ := ParseWorker(worker)
	p := &Parser{open: map[string][2]int{}}
	if Traceable(worker) {
		p.tool = s.Tool
	}
	return p
}

// Feed 读一段完整的行。
func (p *Parser) Feed(text string) {
	for _, l := range strings.Split(text, "\n") {
		p.Line(l)
	}
}

// Line 读一行。
func (p *Parser) Line(line string) {
	line = strings.TrimRight(line, "\r\n")
	if strings.TrimSpace(line) == "" {
		return
	}
	var e event
	if p.tool != "" {
		e = parseEvent(line)
	}
	switch {
	case e == nil:
		p.raw(line)
	case p.tool == "claude":
		p.claude(e)
	case p.tool == "agy":
		p.agy(e, line)
	default:
		p.codex(e, line)
	}
}

// Trace 是到目前为止的经过。收尾总结与最后一段话同文（claude 的 result 重复最后一条回复）时，那段并进结果。
func (p *Parser) Trace() Trace {
	t := p.t
	if t.Segments == nil {
		t.Segments = []Segment{}
	}
	if n := len(t.Segments); t.Ended && n > 0 && len(t.Segments[n-1].Cmds) == 0 && firstPara(t.Segments[n-1].Say) == firstPara(t.Result) {
		t.Segments = t.Segments[:n-1]
	}
	if n := len(t.Lines); n > rawLines {
		t.Lines = t.Lines[n-rawLines:]
	}
	return t
}

// ReadTrace 读整份日志攒成经过；最后没写完的半行不读，日志还没有时为空。
func ReadTrace(worker, path string) (Trace, error) {
	p := NewParser(worker)
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return p.Trace(), nil
	}
	if err != nil {
		return Trace{}, err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 64*1024)
	for {
		line, err := r.ReadString('\n')
		if err == io.EOF {
			return p.Trace(), nil
		}
		if err != nil {
			return Trace{}, err
		}
		p.Line(line)
	}
}

func (p *Parser) claude(e event) {
	if e["parent_tool_use_id"] != nil {
		return // 子代理内部的步骤不算，它的调用本身已记在父级
	}
	content, _ := e.obj("message")["content"].([]any)
	switch e.str("type") {
	case "assistant":
		for _, c := range content {
			m := event(asMap(c))
			switch m.str("type") {
			case "text":
				p.say(m.str("text"))
			case "tool_use":
				cmd := m.obj("input").str("command")
				if m.str("name") != "Bash" || cmd == "" {
					in, _ := json.Marshal(m["input"])
					cmd = m.str("name") + " " + string(in)
				}
				p.call(m.str("id"), cmd)
			}
		}
	case "user":
		for _, c := range content {
			m := event(asMap(c))
			if m.str("type") != "tool_result" {
				continue
			}
			out, code := toolText(m["content"]), 0
			if m["is_error"] == true {
				code = -1
				if s := exitCodeRE.FindStringSubmatch(out); s != nil {
					code, _ = strconv.Atoi(s[1])
				}
			}
			p.result(m.str("tool_use_id"), code, out)
		}
	case "result":
		p.t.Ended, p.t.Result, p.t.Ms = true, strings.TrimSpace(e.str("result")), 0
		if ms, ok := e["duration_ms"].(float64); ok {
			p.t.Ms = int64(ms)
		}
	}
}

var exitCodeRE = regexp.MustCompile(`^Exit code (\d+)`)

func (p *Parser) codex(e event, line string) {
	switch e.str("type") {
	case "item.started", "item.completed":
		it := e.obj("item")
		id, done := it.str("id"), e.str("type") == "item.completed"
		if it.str("type") == "agent_message" {
			if done {
				p.say(it.str("text"))
			}
			return
		}
		cmd, out, code := codexItem(it)
		if cmd == "" {
			return // 思考、待办等不是命令
		}
		if _, ok := p.open[id]; !ok {
			p.call(id, cmd)
		}
		if done {
			p.result(id, code, out)
		}
	case "turn.completed":
		p.t.Ended, p.t.Result = true, p.lastSay
	case "error", "turn.failed":
		p.raw(line)
	}
}

// agy 的事件只报步骤，不带它说的话：每个工具步骤一条命令（ACTIVE 在跑、DONE 完成、ERROR 出错，不报退出码），
// 收尾 result 的 response 是总结。
func (p *Parser) agy(e event, line string) {
	switch e.str("event") {
	case "step_update":
		s := e.obj("step_update")
		if s.str("step_type") != "tool" {
			return
		}
		id, info := fmt.Sprint(s["step_index"]), s.obj("tool_info")
		if _, ok := p.open[id]; !ok {
			cmd := info.obj("parameters").str("CommandLine")
			if s.str("tool_name") != "run_command" || cmd == "" {
				in, _ := json.Marshal(info["parameters"])
				cmd = s.str("tool_name") + " " + string(in)
			}
			p.call(id, cmd)
		}
		switch s.str("state") {
		case "DONE":
			p.result(id, 0, info.str("output"))
		case "ERROR":
			p.result(id, -1, info.obj("error").str("message"))
		}
	case "result":
		if r := e.obj("result"); r.str("status") == "SUCCESS" {
			p.t.Ended, p.t.Result = true, strings.TrimSpace(r.str("response"))
		} else {
			p.raw(line)
		}
	}
}

// codexItem 取 codex 一项的命令原文、输出与退出码（-1 表示出错但没有退出码）；不是命令的项 cmd 为空。
func codexItem(it event) (cmd, out string, code int) {
	failed := it.str("status") == "failed" || it.str("status") == "declined"
	code = 0
	if failed {
		code = -1
	}
	marshal := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	switch it.str("type") {
	case "command_execution":
		cmd, out = unwrapShell(it.str("command")), it.str("aggregated_output")
		if c, ok := it["exit_code"].(float64); ok {
			code = int(c)
		}
	case "file_change":
		cmd = "file_change " + marshal(it["changes"])
	case "mcp_tool_call":
		cmd = it.str("server") + "." + it.str("tool") + " " + marshal(it["arguments"])
		if msg := it.obj("error").str("message"); msg != "" {
			out, code = msg, -1
		} else if it["result"] != nil {
			out = marshal(it["result"])
		}
	case "web_search":
		cmd = "web_search " + it.str("query")
	}
	return cmd, out, code
}

func (p *Parser) say(text string) {
	if text = strings.TrimSpace(text); text == "" {
		return
	}
	p.resume()
	p.t.Segments = append(p.t.Segments, Segment{Say: text})
	p.lastSay = text
}

func (p *Parser) call(id, cmd string) {
	p.resume()
	if len(p.t.Segments) == 0 {
		p.t.Segments = []Segment{{}}
	}
	i := len(p.t.Segments) - 1
	s := &p.t.Segments[i]
	s.Cmds = append(s.Cmds, Command{Cmd: clipRunes(cmd, cmdRunes), State: CmdRun})
	if id != "" {
		p.open[id] = [2]int{i, len(s.Cmds) - 1}
	}
}

func (p *Parser) result(id string, code int, out string) {
	at, ok := p.open[id]
	if !ok {
		return
	}
	delete(p.open, id)
	c := &p.t.Segments[at[0]].Cmds[at[1]]
	c.State, c.Out = CmdState(c.Cmd, code), tailLines(out, outLines)
}

// resume：收尾之后又有动作（捎话后接着干），前一次收尾作废。
func (p *Parser) resume() {
	p.t.Ended, p.t.Result, p.t.Ms = false, "", 0
}

func (p *Parser) raw(line string) {
	p.t.Lines = append(p.t.Lines, clipRunes(line, lineRunes))
	if n := len(p.t.Lines); n > 2*rawLines {
		p.t.Lines = append([]string(nil), p.t.Lines[n-rawLines:]...)
	}
}

var searchRE = regexp.MustCompile(`^(?:cd [^&;|]+&&\s*)?(?:grep|rg)\b`)

// CmdState 判命令结局（纯函数）：退出码 0 成功；搜索类命令（grep、rg）返回 1 是没搜到；其余出错（code < 0 表示出错但不知道退出码）。
func CmdState(cmd string, code int) string {
	switch {
	case code == 0:
		return CmdOK
	case code == 1 && searchRE.MatchString(strings.TrimSpace(cmd)):
		return CmdNone
	}
	return CmdErr
}

var shellRE = regexp.MustCompile(`(?s)^(?:\S*/)?(?:ba|z)?sh -l?c (.+)$`)

// unwrapShell 去掉 codex 给命令包的「bash -lc '…'」，留命令原文；引号拆不干净就原样返回。
func unwrapShell(cmd string) string {
	m := shellRE.FindStringSubmatch(cmd)
	if m == nil || len(m[1]) < 2 {
		return cmd
	}
	a, q := m[1], m[1][0]
	if (q != '\'' && q != '"') || a[len(a)-1] != q {
		return cmd
	}
	in := a[1 : len(a)-1]
	if q == '\'' {
		out := strings.ReplaceAll(in, `'\''`, "'")
		if strings.Contains(strings.ReplaceAll(in, `'\''`, ""), "'") {
			return cmd
		}
		return out
	}
	var b strings.Builder
	for i := 0; i < len(in); i++ {
		switch c := in[i]; {
		case c == '\\' && i+1 < len(in) && strings.IndexByte("\"\\$`", in[i+1]) >= 0:
			i++
			b.WriteByte(in[i])
		case c == '"':
			return cmd
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// toolText 取工具结果的文字：字符串，或文字块数组。
func toolText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	list, _ := v.([]any)
	var parts []string
	for _, x := range list {
		if m := event(asMap(x)); m.str("type") == "text" {
			parts = append(parts, m.str("text"))
		}
	}
	return strings.Join(parts, "\n")
}

func tailLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, " \t\r\n"), "\n")
	lines = lines[max(len(lines)-n, 0):]
	for i, l := range lines {
		lines[i] = clipRunes(strings.TrimRight(l, "\r"), lineRunes)
	}
	return strings.Join(lines, "\n")
}

func clipRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

func firstPara(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "\n\n"); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}
