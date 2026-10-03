package workers

// kimi -p --output-format stream-json：正文是 assistant，工具结果是 tool，恢复提示是 meta。
// 含工具调用的消息尚未完成助手回复，不能使用其中的结论放行。
func kimiReply(e event) string {
	if len(asList(e["tool_calls"])) != 0 {
		return ""
	}
	return e.str("content")
}

func readKimi(p *Parser, e event, _ string) bool {
	switch e.str("role") {
	case "assistant":
		p.say(e.str("content"))
		for _, v := range asList(e["tool_calls"]) {
			call := event(asMap(v))
			f := call.obj("function")
			args := parseEvent(f.str("arguments"))
			p.call(call.str("id"), p.step(f.str("name"), args))
		}
		p.t.Result = kimiReply(e)
	case "tool":
		p.result(e.str("tool_call_id"), 0, e.str("content"))
	case "meta":
		switch e.str("type") {
		case "session.resume_hint":
			p.t.Session = e.str("session_id")
		case "system.version", "turn.step.retrying":
		default:
			return false
		}
	default:
		return false
	}
	return true
}
