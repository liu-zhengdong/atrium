package events

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
)

// LevelOf 是事件的缺省级别：任务失败、受阻、到期、上限满了、自升级失败与负责人上交（已上线除外）要处理；其余只知会。
// 上交必须是「要处理」：上一层负责人按要处理的事件被唤醒，秘书的 events wait 也只取要处理的。
func LevelOf(kind string, body any) string {
	switch kind {
	case Overdue, OnlineFailed, LimitFull:
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

// KeyOf 是事件的缺省去重键：同一件任务的状态变化合并成最新一条；同一部门同一项上限合并；其余不合并。
func KeyOf(e Event) string {
	if e.Kind == TaskStatus && e.Task != "" {
		return "task:" + e.Task
	}
	if e.Kind == LimitFull {
		if k := field(e.Body, "key"); k != "" {
			return "limit:" + e.Dept + ":" + k
		}
	}
	return ""
}

// Delivery 是一件任务事件的一份投递。
type Delivery struct {
	Target string
	Level  string
}

// Result 判断任务事件是不是结果：完成、落地推进一步（如已合入等发版）、失败、受阻（卡住、交回超过次数、上线失败都转受阻）。
// 其余（入队、拉起、交回一次、取消、改回 todo）是过程。
func Result(kind string, body any) bool {
	if kind != TaskStatus {
		return false
	}
	switch field(body, "to") {
	case "done", "failed", "blocked":
		return true
	}
	return field(body, "event") == "land"
}

// Route 纯函数：任务事件投给谁、什么级别。owner 是处理人（task add --owner，缺省派活的人），
// leader 是部门往上最近的负责人（没有为空）。
//   - 等验收（accept_by）投验收人，要处理：user 经秘书投给用户，leader 投部门负责人（没有投秘书）。
//   - 结果投给处理人，要处理：用户与秘书都投秘书（用户经秘书会话收），负责人投自己；
//     运行时建的（审阅任务等）按部门找负责人、没有投秘书，成功由运行时自己接着走，只有失败、受阻要处理。
//   - 负责人不是收结果的那位时，另收一份知会（不叫醒）；过程事件只知会负责人，没有负责人就不投。
func Route(owner, leader, kind string, body any) []Delivery {
	to, level := owner, Act
	accept := field(body, "accept_by")
	switch {
	case accept == "user":
		to = Secretary
	case accept != "":
		to = leader
		if to == "" {
			to = Secretary
		}
	case owner == "u1" || owner == Secretary:
		to = Secretary
	case api.IsRef(owner, "a"):
	default:
		to, level = leader, LevelOf(kind, body)
		if to == "" {
			to = Secretary
		}
	}
	var out []Delivery
	if accept != "" || Result(kind, body) {
		out = append(out, Delivery{to, level})
	} else {
		to = ""
	}
	if leader != "" && leader != to {
		out = append(out, Delivery{leader, Info})
	}
	return out
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
		line := s("from") + " → " + s("to")
		if st := s("stage"); st != "" {
			line += "（" + st + "）"
		}
		if n := s("note"); n != "" {
			title += " · " + clip(n, 80)
		}
		return line + title
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
	case LimitFull:
		line := clip(s("text"), 80)
		if n := s("next"); n != "" {
			line += " · " + n
		}
		return line
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
