package workers

import "strings"

// 各工具的日志解析（reader）：挂在各自的 Driver.read 上。每个 reader 把认得的事件都列出来（用不上的也列，返回 true），
// 列表以外的返回 false，经过里记成「没认出」——工具改了格式看得见。样本在 testdata/<工具>-*.jsonl。

// dsh --profile headless --json：session 带会话 id（记裸 uuid，与 SessionOf 取到的同一份）与工作目录；
// status 的 step_end 带这一步的用量（每步增量、跨重试累加），thinking 是推理（认出不记），text 是它说的话；
// tool_call/tool_result 是一次调用与结果（status 只有 completed 与 error）；final 是收尾正文。
// final 无论成败都写（dsh-headless 的投影在轮次结束时无条件写出终稿），所以成败看 turn_end 的 reason——见 signals.go。
func readDSH(p *Parser, e event, line string) bool {
	switch e.str("type") {
	case "session":
		p.dir = e.str("cwd")
		p.t.Session = strings.TrimPrefix(e.str("sessionId"), "session-")
	case "status":
		switch e.str("phase") {
		case "turn_start", "step_start", "turn_end":
		case "step_end":
			us := e.obj("usage")
			if len(us) > 0 {
				p.addUsage(Usage{Tokens: Tokens{Input: number(us, "inputTokens"), Output: number(us, "outputTokens"),
					CacheRead: number(us, "cacheReadTokens"), CacheWrite: number(us, "cacheWriteTokens")}})
			}
		default:
			return false
		}
	case "thinking":
	case "text":
		p.say(e.str("text"))
	case "tool_call":
		in := e.obj("input")
		cmd := in.str("command")
		if e.str("tool") != "bash" || cmd == "" {
			cmd = p.step(e.str("tool"), in)
		}
		p.call(e.str("callId"), cmd)
	case "tool_result":
		code := 0
		if e.str("status") == "error" {
			code = -1
		}
		p.result(e.str("callId"), code, e.str("result"))
	case "final":
		p.t.Error = "" // 正常收到终稿：之前的报错已被越过
		p.end(e.str("text"), 0)
	case "error":
		p.raw(line)
		p.t.Error = e.str("message")
	default:
		return false
	}
	return true
}
