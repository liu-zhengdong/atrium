package workers

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// 各工具的日志解析（reader）：挂在各自的 Driver.read 上。每个 reader 把认得的事件都列出来（用不上的也列，返回 true），
// 列表以外的返回 false，经过里记成「没认出」——工具改了格式看得见。样本在 testdata/<工具>-*.jsonl。

// claude -p --output-format stream-json：assistant 的 text 是它说的话、tool_use 是调用，user 的 tool_result 是结果，result 收尾。
func readClaude(p *Parser, e event, _ string) bool {
	if e["parent_tool_use_id"] != nil {
		return true // 子代理内部的步骤不算，它的调用本身已记在父级
	}
	content, _ := e.obj("message")["content"].([]any)
	switch e.str("type") {
	case "system":
		if e.str("subtype") == "init" {
			p.dir, p.t.Model = e.str("cwd"), e.str("model")
			p.t.Session = e.str("session_id")
		}
	case "assistant":
		for _, c := range content {
			m := event(asMap(c))
			switch m.str("type") {
			case "text":
				p.say(m.str("text"))
			case "tool_use":
				cmd := m.obj("input").str("command")
				if m.str("name") != "Bash" || cmd == "" {
					cmd = p.step(m.str("name"), m.obj("input"))
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
		u := snakeUsage(e.obj("usage"))
		u.Cost, u.Currency = reportedCost(e, "total_cost_usd"), "USD"
		p.addUsage(u)
		// Claude 收尾花费是会话累计值，多轮只留最后一份。
		p.t.Usage.Cost = u.Cost
		p.t.Usage.Source, p.t.Usage.Currency = "", ""
		if u.Cost != nil {
			p.t.Usage.Source, p.t.Usage.Currency = "tool", "USD"
		}
		ms, _ := e["duration_ms"].(float64)
		p.end(e.str("result"), int64(ms))
	case "rate_limit_event", "tool_progress", "command_lifecycle", "stream_event":
	default:
		return false
	}
	return true
}

var exitCodeRE = regexp.MustCompile(`^Exit code (\d+)`)

// grok --output-format streaming-messages-json：整条 assistant/user/result 与 Claude 同形。
// 只接受下列事件；工具名称不同，终端调用转换为共用解析器的命令步骤；
// 服务端工具 server_tool_use（web_search）是真实一步，其结果 web_search_tool_result 认出但不展开。
func readGrok(p *Parser, e event, line string) bool {
	switch e.str("type") {
	case "system":
		if e.str("subtype") != "init" {
			return false
		}
	case "assistant":
		content, _ := e.obj("message")["content"].([]any)
		for _, c := range content {
			m := event(asMap(c))
			switch m.str("type") {
			case "text", "thinking":
			case "tool_use":
				if m.str("name") == "run_terminal_command" {
					m["name"] = "Bash"
				}
			case "server_tool_use":
				p.call(m.str("id"), p.step(m.str("name"), m.obj("input")))
			case "web_search_tool_result":
				p.result(m.str("tool_use_id"), 0, "")
			default:
				return false
			}
		}
	case "user":
		content, _ := e.obj("message")["content"].([]any)
		for _, c := range content {
			switch event(asMap(c)).str("type") {
			case "text", "tool_result":
			default:
				return false
			}
		}
	case "result":
	case "stream_event": // --include-partial-messages 的增量；整条消息负责显示。
		return true
	default:
		return false
	}
	return readClaude(p, e, line)
}

// codex exec --json：item 是一项（agent_message 是它说的话，命令、改文件、MCP、搜索是调用），turn.completed 收尾（总结是最后一句话）。
func readCodex(p *Parser, e event, line string) bool {
	switch e.str("type") {
	case "thread.started", "turn.started":
	case "item.started", "item.updated", "item.completed":
		it := e.obj("item")
		id, done := it.str("id"), e.str("type") == "item.completed"
		switch it.str("type") {
		case "agent_message":
			if done {
				p.say(it.str("text"))
			}
		case "reasoning", "todo_list":
		case "error":
			p.raw(line)
		default:
			cmd, out, code := codexItem(p, it)
			if cmd == "" {
				return false
			}
			if _, ok := p.open[id]; !ok {
				p.call(id, cmd)
			}
			if done {
				p.result(id, code, out)
			}
		}
	case "turn.completed":
		u := snakeUsage(e.obj("usage"))
		u.CacheRead = number(e.obj("usage"), "cached_input_tokens")
		u.CacheWrite = number(e.obj("usage"), "cache_write_input_tokens")
		if u.Input != nil && u.CacheRead != nil {
			n := *u.Input - *u.CacheRead
			if u.CacheWrite != nil {
				n -= *u.CacheWrite
			}
			if n >= 0 {
				u.Input = &n
			} else {
				u.Input = nil
			}
		} else {
			u.Input = nil // 缓存读缺失时，不能把总输入当成未缓存输入。
		}
		p.addUsage(u)
		p.end(p.lastSay, 0)
	case "error", "turn.failed":
		p.raw(line)
	default:
		return false
	}
	return true
}

// codexItem 取 codex 一项调用的命令、输出与退出码（-1 表示出错但没有退出码）；认不出的项 cmd 为空。
func codexItem(p *Parser, it event) (cmd, out string, code int) {
	if s := it.str("status"); s == "failed" || s == "declined" {
		code = -1
	}
	switch it.str("type") {
	case "command_execution":
		cmd, out = unwrapShell(it.str("command")), it.str("aggregated_output")
		if c, ok := it["exit_code"].(float64); ok {
			code = int(c)
		}
	case "file_change":
		changes, _ := it["changes"].([]any)
		var parts []string
		for _, c := range changes {
			m := event(asMap(c))
			parts = append(parts, p.step(m.str("kind"), m))
		}
		cmd = "file_change " + strings.Join(parts, "、")
	case "mcp_tool_call":
		args, _ := it["arguments"].(map[string]any)
		cmd = p.step(it.str("server")+"."+it.str("tool"), args)
		if msg := it.obj("error").str("message"); msg != "" {
			out, code = msg, -1
		} else if it["result"] != nil {
			b, _ := json.Marshal(it["result"])
			out = string(b)
		}
	case "web_search":
		cmd = "web_search " + it.str("query")
	}
	return cmd, out, code
}

// agy --output-format stream-json：step_update 一步一条（agent_response 是它说的话，按 text_delta 片段送、DONE 时说完；
// tool 是调用，ACTIVE 在跑、DONE 完成、ERROR 出错，不报退出码）；result 收尾，response 把说过的话连成一片，说过话时总结取最后一句。
func readAgy(p *Parser, e event, line string) bool {
	switch e.str("event") {
	case "init":
		p.dir, p.t.Model = e.obj("init").str("cwd"), e.obj("init").str("model")
	case "step_update":
		s := e.obj("step_update")
		id := fmt.Sprint(s["step_index"])
		switch s.str("step_type") {
		case "agent_response":
			p.pending[id] += s.str("text_delta")
			if s.str("state") == "DONE" {
				u := snakeUsage(s.obj("usage"))
				u.CacheRead = number(s.obj("usage"), "cache_read_tokens")
				u.CacheWrite = number(s.obj("usage"), "cache_write_tokens")
				p.addUsage(u)
				p.say(p.pending[id])
				delete(p.pending, id)
			}
		case "tool", "subagent":
			info := s.obj("tool_info")
			if _, ok := p.open[id]; !ok {
				p.call(id, agyStep(p, s))
			}
			switch s.str("state") {
			case "DONE":
				p.result(id, 0, info.str("output"))
			case "ERROR":
				p.result(id, -1, info.obj("error").str("message"))
			}
		case "user_input", "system_message", "error_message", "checkpoint":
		default:
			return false
		}
	case "result":
		r := e.obj("result")
		if r.str("status") != "SUCCESS" {
			p.raw(line)
			break
		}
		summary := r.str("response")
		if p.lastSay != "" {
			summary = p.lastSay
		}
		sec, _ := r["duration_seconds"].(float64)
		p.end(summary, int64(sec*1000))
	default:
		return false
	}
	return true
}

// agyStep：run_command 给命令原文，子代理给各自的角色，其余「工具名 要点」。
func agyStep(p *Parser, s event) string {
	if s.str("step_type") == "subagent" {
		list, _ := s.obj("subagent_info")["subagents"].([]any)
		var roles []string
		for _, a := range list {
			roles = append(roles, event(asMap(a)).str("role"))
		}
		return "subagent " + strings.Join(roles, "、")
	}
	in := s.obj("tool_info").obj("parameters")
	if cmd := in.str("CommandLine"); s.str("tool_name") == "run_command" && cmd != "" {
		return cmd
	}
	return p.step(s.str("tool_name"), in)
}

// cursor-agent --output-format stream-json：assistant 是它说的话，tool_call 的 started／completed 是调用与结果
// （键名 shellToolCall、readToolCall……区分工具），result 收尾，它的 result 把说过的话连成一片，总结取最后一句。
func readCursor(p *Parser, e event, _ string) bool {
	switch e.str("type") {
	case "system":
		if e.str("subtype") == "init" {
			p.dir, p.t.Model = e.str("cwd"), e.str("model")
		}
	case "user", "thinking", "connection", "retry":
	case "interaction_query":
		// 抓网页、搜索前向 cursor 要授权（request）与应答（response）：认出但不显示——同一次调用已是一条 tool_call
		// 步骤（webFetch 网址），没放行的在它的结果里报出错。
		return e.str("subtype") == "request" || e.str("subtype") == "response"
	case "assistant":
		content, _ := e.obj("message")["content"].([]any)
		for _, c := range content {
			if m := event(asMap(c)); m.str("type") == "text" {
				p.say(m.str("text"))
			}
		}
	case "tool_call":
		name, call := cursorTool(e.obj("tool_call"))
		sub, id := e.str("subtype"), e.str("call_id")
		if name == "" || (sub != "started" && sub != "completed") {
			return false
		}
		if _, ok := p.open[id]; !ok {
			cmd := call.obj("args").str("command")
			if name != "shell" || cmd == "" {
				cmd = p.step(name, call.obj("args"))
			}
			p.call(id, cmd)
		}
		if sub == "completed" {
			code, out := cursorResult(call.obj("result"))
			p.result(id, code, out)
		}
	case "result":
		summary := p.lastSay
		if summary == "" {
			summary = e.str("result")
		}
		ms, _ := e["duration_ms"].(float64)
		us := e.obj("usage")
		u := Usage{Tokens: Tokens{Input: number(us, "inputTokens"), Output: number(us, "outputTokens"), CacheRead: number(us, "cacheReadTokens"), CacheWrite: number(us, "cacheWriteTokens")}, Cost: reportedCost(e, "total_cost_usd"), Currency: "USD"}
		p.addUsage(u)
		p.end(summary, int64(ms))
	default:
		return false
	}
	return true
}

// cursorTool 从 tool_call 里取工具名（shellToolCall → shell）与它的内容；没有 …ToolCall 键时名字为空。
func cursorTool(tc event) (string, event) {
	for k, v := range tc {
		if name, ok := strings.CutSuffix(k, "ToolCall"); ok && name != "" {
			return name, asMap(v)
		}
	}
	return "", nil
}

// cursorResult 取调用结果的退出码与输出：success 成功，其余（failure……）出错；shell 报了退出码就用它。
func cursorResult(r event) (int, string) {
	res, code := r.obj("success"), 0
	if res == nil {
		code, res = -1, r.obj("failure")
	}
	if c, ok := res["exitCode"].(float64); ok {
		code = int(c)
	}
	out := res.str("interleavedOutput")
	if out == "" {
		out = strings.TrimSpace(res.str("stdout") + "\n" + res.str("stderr"))
	}
	if out == "" && code != 0 {
		b, _ := json.Marshal(r)
		out = string(b)
	}
	return code, out
}

// opencode run --format json：text 是它说的话，tool_use 在调用完成或出错时一次报齐（bash 的退出码在 metadata.exit），
// step_finish 的 reason 为 stop 是收尾（总结是最后一句话）。
func readOpencode(p *Parser, e event, line string) bool {
	part := e.obj("part")
	switch e.str("type") {
	case "step_start", "reasoning":
	case "text":
		p.say(part.str("text"))
	case "tool_use":
		st, in := part.obj("state"), part.obj("state").obj("input")
		cmd := in.str("command")
		if part.str("tool") != "bash" || cmd == "" {
			cmd = p.step(part.str("tool"), in)
		}
		id := part.str("callID")
		if id == "" {
			id = part.str("id")
		}
		p.call(id, cmd)
		code, out := 0, st.str("output")
		if st.str("status") == "error" {
			code, out = -1, st.str("error")
		} else if c, ok := st.obj("metadata")["exit"].(float64); ok {
			code = int(c)
		}
		p.result(id, code, out)
	case "step_finish":
		tk := part.obj("tokens")
		u := Usage{Tokens: Tokens{Input: number(tk, "input"), Output: number(tk, "output"), CacheRead: number(tk.obj("cache"), "read"), CacheWrite: number(tk.obj("cache"), "write")}, Cost: reportedCost(part, "cost"), Currency: "USD"}
		if reasoning := number(tk, "reasoning"); reasoning != nil {
			u.Output = sumToken(u.Output, reasoning)
		}
		p.addUsage(u)
		if part.str("reason") == "stop" {
			p.end(p.lastSay, 0)
		}
	case "error":
		p.raw(line)
	default:
		return false
	}
	return true
}
