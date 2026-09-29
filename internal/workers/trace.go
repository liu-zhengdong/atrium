package workers

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"regexp"
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
	Ended    bool      `json:"ended"`             // 走到了收尾
	Result   string    `json:"result,omitempty"`  // 收尾总结全文
	Ms       int64     `json:"ms,omitempty"`      // 用时（工具报了才有）
	Lines    []string  `json:"lines,omitempty"`   // 其他输出原文（最后 rawLines 行）：非事件行、报错事件、没认出的事件；解析不了的工具全在这里
	Unknown  int       `json:"unknown,omitempty"` // 没认出的事件行数：非零说明工具的日志格式变了，解析要跟上
}

// Segment 是经过里的一段：执行者说的一句话和它之后跑的命令。Say 为空是开头还没说话的那段。
type Segment struct {
	Say  string    `json:"say"`
	Cmds []Command `json:"cmds,omitempty"`
}

// Command 是一条工具调用：shell 是命令原文，其余工具是「工具名 要点」（Parser.step）。
type Command struct {
	Cmd   string `json:"cmd"`
	State string `json:"state"`
	Out   string `json:"out,omitempty"` // 输出最后 outLines 行
}

// reader 认一行 JSON 事件，经 Parser 的 say、call、result、end 记下；返回 false 表示没认出。
// 每个输出 JSON 事件的内置工具在自己的 Driver 上带一个（Driver.read），与怎么拉起写在一起。
type reader func(p *Parser, e event, line string) bool

func readerOf(worker string) reader {
	s, _ := ParseWorker(worker)
	if d, ok := Builtin(s.Tool); ok {
		return d.read
	}
	return nil
}

// Traceable：这个执行者（工具[+模型][:强度]）的工具带解析，日志能按段看；其余工具按原文逐行看。
func Traceable(worker string) bool { return readerOf(worker) != nil }

// Parser 逐行读执行者日志攒成 Trace（无 IO）：工具带解析的按事件读，其余逐行留原文。
type Parser struct {
	read    reader
	t       Trace
	open    map[string][2]int // 还没结果的工具调用 → 段、命令下标
	lastSay string
	dir     string            // 工作目录（工具在开头报了才有）：步骤里的路径去掉这个前缀
	pending map[string]string // 按片段送来、还没说完的话（agy）
}

func NewParser(worker string) *Parser {
	return &Parser{read: readerOf(worker), open: map[string][2]int{}, pending: map[string]string{}}
}

// Feed 读一段完整的行。
func (p *Parser) Feed(text string) {
	for _, l := range strings.Split(text, "\n") {
		p.Line(l)
	}
}

// Line 读一行：不是 JSON 的行留原文；JSON 事件交给工具的解析，没认出的记数并留原文。
func (p *Parser) Line(line string) {
	line = strings.TrimRight(line, "\r\n")
	if strings.TrimSpace(line) == "" {
		return
	}
	var e event
	if p.read != nil {
		e = parseEvent(line)
	}
	if e == nil {
		p.raw(line)
	} else if !p.read(p, e, line) {
		p.t.Unknown++
		p.raw(line)
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

// end 记收尾：summary 是收尾总结，ms 是用时（没报为 0）。
func (p *Parser) end(summary string, ms int64) {
	p.t.Ended, p.t.Result, p.t.Ms = true, strings.TrimSpace(summary), ms
}

// 步骤要点取输入里的哪些项：先「什么」（搜索词、网址、说明），后「在哪」（路径）。
var (
	stepWhat  = []string{"pattern", "query", "Query", "url", "Url", "description"}
	stepWhere = []string{"file_path", "filePath", "path", "AbsolutePath", "TargetFile", "DirectoryPath", "SearchPath", "notebook_path"}
)

// step 把非 shell 的工具步骤写成「工具名 要点」（view_file internal/README.md），路径去掉工作目录前缀；输入里没有这些项才给整段参数。
func (p *Parser) step(name string, in map[string]any) string {
	parts := []string{name}
	for _, keys := range [][]string{stepWhat, stepWhere} {
		for _, k := range keys {
			if v, _ := in[k].(string); v != "" {
				if p.dir != "" {
					v = strings.TrimPrefix(v, p.dir+"/")
				}
				parts = append(parts, v)
				break
			}
		}
	}
	if len(parts) == 1 && len(in) > 0 {
		b, _ := json.Marshal(in)
		parts = append(parts, string(b))
	}
	return strings.Join(parts, " ")
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
