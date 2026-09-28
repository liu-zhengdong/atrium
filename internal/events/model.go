package events

import (
	"encoding/json"
	"fmt"
	"strings"
)

// LevelOf 是事件的缺省级别：任务失败、受阻、到期与负责人上交（已上线除外）要处理；其余只知会。
// 上交必须是「要处理」：上一层负责人按要处理的事件被唤醒，秘书的 events wait 也只取要处理的。
func LevelOf(kind string, body any) string {
	switch kind {
	case Overdue:
		return Act
	case LeaderEscalate:
		if field(body, "kind") == "shipped" {
			return Info
		}
		return Act
	case TaskStatus:
		switch field(body, "to") {
		case "failed", "blocked":
			return Act
		}
	}
	return Info
}

// KeyOf 是事件的缺省去重键：同一件任务的状态变化合并成最新一条；其余不合并。
func KeyOf(e Event) string {
	if e.Kind == TaskStatus && e.Task != "" {
		return "task:" + e.Task
	}
	return ""
}

func field(body any, name string) string {
	m, ok := body.(map[string]any)
	if !ok || m[name] == nil {
		return ""
	}
	return fmt.Sprint(m[name])
}

// Summary 是事件正文的一句话（bridge 注入、events wait 列表都用它）。
func Summary(r Row) string {
	var b map[string]any
	if len(r.Body) > 0 {
		_ = json.Unmarshal(r.Body, &b) // 正文不是对象时只显示种类
	}
	s := func(k string) string {
		if b == nil || b[k] == nil {
			return ""
		}
		return fmt.Sprint(b[k])
	}
	title := ""
	if t := s("title"); t != "" {
		title = "「" + clip(t, 40) + "」"
	}
	switch r.Kind {
	case TaskStatus:
		return fmt.Sprintf("%s → %s%s", s("from"), s("to"), title)
	case Overdue:
		line := "到期：" + clip(s("text"), 60)
		if ms, ok := b["held_ms"].(float64); ok {
			line += fmt.Sprintf("（已 %d 分钟）", int(ms/60000))
		}
		if n := s("next"); n != "" {
			line += " · " + n
		}
		return line + title
	case LeaderEscalate:
		return fmt.Sprintf("%s 上交（%s）：%s", s("from"), s("label"), clip(s("note"), 80))
	}
	return r.Kind + title
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}
