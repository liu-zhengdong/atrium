package workers

import "strings"

// maxReply 是记下的最后回复的上限（字符）。
const maxReply = 8000

// LastReply 取执行者最后一条回复（纯函数）：stream-json 取收尾事件的 result（agy 取 response），
// opencode 取最后一段文字，codex 取最后一条 agent_message；文本日志取末尾若干行。gates 从这里读审阅结论。
func (a *Driver) LastReply(tail string) string {
	lines := strings.Split(strings.TrimRight(tail, "\n"), "\n")
	if a.Tool == "kimi" {
		for i := len(lines) - 1; i >= 0; i-- {
			if e := parseEvent(lines[i]); e != nil && e.str("role") == "assistant" {
				return clip(kimiReply(e))
			}
		}
		return ""
	}
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
			case e.str("type") == "turn_end", e.str("type") == "message_end":
				if m := e.obj("message"); m.str("role") == "assistant" {
					if t := piResultText(m); t != "" {
						return clip(t)
					}
				}
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
