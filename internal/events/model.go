package events

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/org"
)

// LevelOf 是事件的缺省级别：任务失败、受阻、等验收、非用户本人做的完成，交给负责人去拆的任务，到期、上限满了、自升级失败与负责人上报要处理；
// 其余只知会，包括应用的中间步骤（如已合入等发版）与用户本人（u1）做的完成、验收通过——用户亲手做的不再推回给秘书。
// 正文的 by 是引起它的身份（ledger 填操作人）。
// notify 的处理是秘书转告用户，不要求回复或拍板；ask 是秘书把问题转告用户，用户回话经 task tell 送回任务。
// 上报必须是「要处理」：上一层负责人按要处理的事件被唤醒，秘书的 events wait 也只取要处理的。
func LevelOf(kind string, body any) string {
	switch kind {
	case Overdue, OnlineFailed, LimitFull, TaskAssigned, LeaderEscalate:
		return Act
	case TaskStatus:
		switch to := field(body, "to"); {
		case to == "failed", to == "blocked", field(body, "accept_by") != "":
			return Act
		case to == "done" && field(body, "by") != "u1":
			return Act
		}
	}
	return Info
}

// KeyOf 是事件的缺省去重键：同一件任务的状态变化合并成最新一条，交给负责人去拆（连同之后的补充说明）也合并成最新一条；
// 同一部门同一项上限合并；其余不合并。
func KeyOf(e Event) string {
	if e.Kind == TaskStatus && e.Task != "" {
		return "task:" + e.Task
	}
	if e.Kind == TaskAssigned && e.Task != "" {
		return "assigned:" + e.Task
	}
	if e.Kind == LimitFull {
		if k := field(e.Body, "key"); k != "" {
			return "limit:" + e.Dept + ":" + k
		}
	}
	return ""
}

// Delivery 是一件任务事件发给谁、什么级别。
type Delivery struct {
	Target string
	Level  string
}

// result 判断任务事件是不是结果：完成、应用推进一步（如已合入等发版）、失败、受阻（卡住、交回超过次数、上线失败都转受阻）。
// 其余（入队、拉起、交回一次、取消、改回 todo）是过程。
func result(kind string, body any) bool {
	if kind != TaskStatus {
		return false
	}
	switch field(body, "to") {
	case "done", "failed", "blocked":
		return true
	}
	return field(body, "event") == "land"
}

// Route 纯函数：任务事件发给谁、什么级别；只投要动手的那一位，不投返回 false。owner 是处理人（task add --owner，
// 缺省分派任务的人），assigner 是任务分派人，leader 是部门往上最近的负责人（没有为空）。正文的 by 是本次操作人。
//   - 等验收（accept_by）投验收人：user 经秘书发给用户，leader 投部门负责人（没有投秘书）。
//   - 负责人自己引起的结果改投任务分派人：u1、secretary 投秘书，其他负责人投本人；任务分派人为空或就是处理人则不投。
//   - 其余结果按 LevelOf 的级别投处理人：负责人（aN）投本人；秘书、用户派的与运行时建的，部门有负责人投负责人，
//     没有投秘书。运行时建的（审阅任务等）成功由运行时自己接着走，只知会。
//   - 过程（入队、拉起、交回一次、取消、改回 todo）不投：没有要动手的事。
func Route(owner, assigner, leader, kind string, body any) (Delivery, bool) {
	accept := field(body, "accept_by")
	if accept == "" && !result(kind, body) {
		return Delivery{}, false
	}
	to, level := leader, LevelOf(kind, body)
	switch {
	case accept == "user":
		to = Secretary
	case accept != "":
	case api.IsRef(owner, "a") && field(body, "by") == owner:
		if assigner == "" || assigner == owner {
			return Delivery{}, false
		}
		to = assigner
		if assigner == "u1" || assigner == Secretary {
			to = Secretary
		}
	case api.IsRef(owner, "a"):
		to = owner
	case owner != "u1" && owner != Secretary && field(body, "to") == "done":
		level = Info
	}
	if to == "" {
		to = Secretary
	}
	return Delivery{to, level}, true
}

func field(body any, name string) string {
	m, ok := body.(map[string]any)
	if !ok || m[name] == nil {
		return ""
	}
	return fmt.Sprint(m[name])
}

// Summary 是事件正文的一句话（bridge 注入、events wait 列表都用它）。
func Summary(r Row, names map[string]string) string {
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
	case TaskAssigned:
		if a := s("ask"); a != "" {
			return "你问用户的「" + clip(a, 40) + "」有回话" + title + "：" + clip(s("tell"), 80)
		}
		if t := s("tell"); t != "" {
			return "交给你拆的" + title + "有补充：" + clip(t, 80)
		}
		return "交给你去拆" + title + "：拆子任务、分派任务、收尾"
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
		from := org.DisplayIdentity(s("from"), names)
		switch s("kind") {
		case "notify":
			return fmt.Sprintf("%s 知会用户：%s（秘书转告用户后确认；不需回复或拍板，负责人继续派活）", from, s("note"))
		case "ask":
			return fmt.Sprintf("%s 问用户（%s）：%s（秘书转告用户后确认；用户回话用 atrium task tell %s <回话> 送回）", from, r.Task, s("note"), r.Task)
		}
		return fmt.Sprintf("%s 上报（%s）：%s", from, s("label"), clip(s("note"), 80))
	case WorkerDown:
		return s("target") + " 不可用：" + clip(s("reason"), 80) + " · " + s("next")
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
