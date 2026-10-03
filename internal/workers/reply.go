package workers

import (
	"bufio"
	"io"
	"os"
	"strings"
)

// maxReply 是记下的最后回复的上限（字符）。
const maxReply = 8000

// ReadReply 读整份日志取执行者最后一条回复；日志还没有时为空。gates 从这里读审阅结论。
// 事件日志不能只看末尾一段：pi 收尾的 agent_end 一行带整场对话，常有几百 KB，会把之前的 message_end 挤出末尾。
func (a *Driver) ReadReply(path string) (string, error) {
	if a.Tool != "kimi" && !a.JSON {
		log, err := Tail(path, TailBytes)
		if os.IsNotExist(err) {
			return "", nil
		}
		return a.LastReply(log.Text), err
	}
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer f.Close()
	last := ""
	r := bufio.NewReaderSize(f, 64*1024)
	for {
		line, err := r.ReadString('\n')
		if text, ok := a.reply(line); ok {
			last = text
		}
		if err == io.EOF {
			return clip(last), nil
		}
		if err != nil {
			return "", err
		}
	}
}

// LastReply 取日志尾巴里执行者最后一条回复（纯函数）；文本日志取末尾若干行。
func (a *Driver) LastReply(tail string) string {
	lines := strings.Split(strings.TrimRight(tail, "\n"), "\n")
	if a.Tool == "kimi" || a.JSON {
		for i := len(lines) - 1; i >= 0; i-- {
			if text, ok := a.reply(lines[i]); ok {
				return clip(text)
			}
		}
		return ""
	}
	if len(lines) > 60 {
		lines = lines[len(lines)-60:]
	}
	return clip(strings.Join(lines, "\n"))
}

// reply 判一行事件是不是执行者的回复（纯函数）：stream-json 取收尾事件的 result（agy 取 response），
// opencode 取一段文字，codex 取 agent_message，pi 取 assistant 有文字的 message_end／turn_end，kimi 取 assistant 消息（带工具调用的算空回复），
// command-code 的收尾行 type 是 result 但正文在 finalText。
func (a *Driver) reply(line string) (string, bool) {
	e := parseEvent(line)
	switch {
	case e == nil:
	case a.Tool == "kimi":
		if e.str("role") == "assistant" {
			return kimiReply(e), true
		}
	case e.str("type") == "result":
		if t := e.str("result"); t != "" {
			return t, true
		}
		return e.str("finalText"), true
	case e.str("event") == "result":
		return e.obj("result").str("response"), true
	case e.str("type") == "text":
		return e.obj("part").str("text"), true
	case e.str("type") == "item.completed" && e.obj("item").str("type") == "agent_message":
		return e.obj("item").str("text"), true
	case e.str("type") == "turn_end", e.str("type") == "message_end":
		if m := e.obj("message"); m.str("role") == "assistant" {
			if t := piResultText(m); t != "" {
				return t, true
			}
		}
	}
	return "", false
}

func clip(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > maxReply {
		return "…" + string(r[len(r)-maxReply:])
	}
	return s
}
