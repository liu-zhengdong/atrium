package secretary

import (
	"fmt"
	"sort"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/watch"
)

const (
	dim    = "\x1b[2m"
	bold   = "\x1b[1m"
	red    = "\x1b[31m"
	green  = "\x1b[32m"
	yellow = "\x1b[33m"
	reset  = "\x1b[0m"
)

// statusTasks：状态栏最多列几件任务，多了写「另 N 件」。
const statusTasks = 4

// kindOrder：先列到期的，再按执行者、负责人、秘书、检查、发版。
var kindOrder = map[string]int{"worker": 1, "leader": 2, "secretary": 3, "check": 4, "release": 5}

// StatusLine 是给 Claude Code 状态栏的一行（纯函数）。
func StatusLine(v watch.View) string {
	paint := func(color, s string) string { return color + s + reset }
	var parts []string
	if len(v.Paused) > 0 {
		parts = append(parts, paint(yellow, "已暂停 "+strings.Join(v.Paused, "、")))
	}
	if v.Choices > 0 {
		parts = append(parts, paint(bold+red, fmt.Sprintf("等你拍板 %d", v.Choices)))
	}
	var rows []watch.TaskRow
	for _, t := range v.Tasks {
		if _, ok := kindOrder[t.Holder.Kind]; ok {
			rows = append(rows, t)
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if (rows[i].Overdue > 0) != (rows[j].Overdue > 0) {
			return rows[i].Overdue > 0
		}
		return kindOrder[rows[i].Holder.Kind] < kindOrder[rows[j].Holder.Kind]
	})
	for i, t := range rows {
		if i == statusTasks {
			parts = append(parts, paint(dim, fmt.Sprintf("另 %d 件", len(rows)-statusTasks)))
			break
		}
		text := t.ID + " " + holderShort(t.Holder)
		if h := watch.Held(t.Holder.Since, v.At); h != "" && t.Holder.Kind == "worker" {
			text += " " + h
		}
		color := green
		switch {
		case t.Overdue > 0:
			color = red
		case t.Holder.Kind != "worker":
			color = yellow
		}
		parts = append(parts, paint(color, text))
	}
	if v.Queued > 0 {
		parts = append(parts, paint(dim, fmt.Sprintf("排队 %d", v.Queued)))
	}
	if len(rows) == 0 && v.Queued == 0 {
		parts = append(parts, paint(dim, "没有在做的事"))
	}
	switch {
	case v.Secretary.Red:
		parts = append(parts, paint(bold+red, fmt.Sprintf("秘书没在听（%d 条事件）", v.Secretary.Pending)))
	case v.Secretary.Listening != nil:
		parts = append(parts, paint(dim, "秘书在听"))
	default:
		parts = append(parts, paint(yellow, "秘书不在听"))
	}
	return strings.Join(parts, paint(dim, " · "))
}

// holderShort：执行者写工具名，其余写谁 + 一句话。
func holderShort(h watch.Holder) string {
	if h.Kind == "worker" {
		w := h.Who
		if i := strings.IndexAny(w, "+:"); i > 0 {
			w = w[:i]
		}
		if w == "" {
			w = "执行者"
		}
		return w
	}
	who := h.Who
	if who == "secretary" {
		who = "秘书"
	}
	return who + " " + h.Text
}
