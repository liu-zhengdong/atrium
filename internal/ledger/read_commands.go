package ledger

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/events"
)

func taskList(c *cli.Ctx) error {
	q := url.Values{}
	if s := c.List("status"); len(s) > 0 {
		q.Set("status", strings.Join(s, ","))
	}
	setIf(q, "org", c.Str("org"))
	setIf(q, "parent", c.Str("parent"))
	setIf(q, "limit", c.Str("limit"))
	if c.Bool("top") {
		q.Set("top", "1")
	}
	var tasks []Task
	if err := c.Call("GET", "/api/tasks?"+q.Encode(), nil, &tasks); err != nil {
		return err
	}
	// 没指定状态时草稿只给数：它们不等人处理，逐条列会挤掉要处理的。
	shown, drafts := tasks, 0
	if len(c.List("status")) == 0 {
		shown = nil
		for _, t := range tasks {
			if t.Status == Draft {
				drafts++
			} else {
				shown = append(shown, t)
			}
		}
	}
	var b strings.Builder
	for _, t := range shown {
		fmt.Fprintf(&b, "%s  %s  %s  %s\n", t.ID, stateLabel(t), t.Priority, t.Title)
	}
	lsDrafts := "atrium task ls --status draft"
	if o := c.Str("org"); o != "" {
		lsDrafts = "atrium task ls --org " + o + " --status draft"
	}
	if drafts > 0 {
		fmt.Fprintf(&b, "另有草稿 %d 件：%s\n", drafts, lsDrafts)
	}
	switch {
	case len(tasks) == 0:
		return c.Done(tasks, "没有任务", "atrium task add <标题>")
	case len(shown) == 0:
		return c.Done(tasks, b.String(), lsDrafts)
	}
	return c.Done(tasks, b.String(), "atrium task show "+shown[0].ID)
}

func taskShow(c *cli.Ctx) error {
	id, err := c.Arg(0, "<tN>")
	if err != nil {
		return err
	}
	var d Detail
	if err := c.Call("GET", "/api/tasks/"+url.PathEscape(id), nil, &d); err != nil {
		return err
	}
	t := d.Task
	// 没结束的任务问 watch「现在在等谁」（当前等待对象判定只有一份，在 watch）。
	var h struct {
		Holder struct {
			Text string `json:"text"`
			Next string `json:"next"`
		} `json:"holder"`
	}
	if !t.Status.Finished() {
		if err := c.Call("GET", "/api/tasks/"+url.PathEscape(id)+"/holder", nil, &h); err != nil {
			return err
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s「%s」\n状态：%s  优先级：%s\n", t.ID, t.Title, stateLabel(t), t.Priority)
	if h.Holder.Text != "" {
		fmt.Fprintf(&b, "现在：%s\n", h.Holder.Text)
	}
	for _, kv := range [][2]string{{"部门", t.Org}, {"父任务", t.Parent}, {"任务分派人", d.Parties.By}, {"处理人", d.Parties.Owner}} {
		if kv[1] != "" {
			fmt.Fprintf(&b, "%s：%s\n", kv[0], kv[1])
		}
	}
	for _, kv := range [][2]string{{"来源", t.Source.By(d.ByName)}, {"类", t.Class}, {"技能", t.Skill}, {"仓库", t.Repo}, {"工作地点", t.Dir}, {"执行者", t.Worker}, {"机器", t.Host}, {"PR", t.PR}} {
		if kv[1] != "" {
			fmt.Fprintf(&b, "%s：%s\n", kv[0], kv[1])
		}
	}
	if len(d.Deps) > 0 {
		parts := make([]string, len(d.Deps))
		for i, dep := range d.Deps {
			parts[i] = dep.ID + " " + string(dep.Status)
		}
		fmt.Fprintf(&b, "依赖：%s\n", strings.Join(parts, "，"))
	}
	if d.Children != nil {
		fmt.Fprintf(&b, "子任务：%s\n", d.Children)
	}
	if t.Detail != "" {
		fmt.Fprintf(&b, "\n%s\n", t.Detail)
	}
	if len(d.History) > 0 {
		b.WriteString("\n经历：\n")
		for _, e := range d.History {
			text, err := historyText(e)
			if err != nil {
				return fmt.Errorf("经历 %d：%w", e.ID, err)
			}
			fmt.Fprintf(&b, "  %s  %s  %s  %s\n", time.UnixMilli(e.At).Format("01-02 15:04"), e.Actor, e.Kind, text)
		}
	}
	next := "atrium task wait " + t.ID
	switch {
	case t.Status == Draft:
		next = "atrium task set " + t.ID + " --status todo"
	case t.Status == Todo && t.Ask != "":
		next = h.Holder.Next // 在问用户：等回话（与等待对象判定同一条）
	case t.Status == Todo && d.Children != nil && d.Children.Open() > 0:
		next = "atrium task tree " + t.ID // 拆开在做的父任务：看子任务，不派它自己
	case t.Status == Todo && d.Children != nil && d.Children.Total > 0:
		next = h.Holder.Next // 子任务终态不代表父任务目标完成；先核对目标再安排或收尾
	case t.Status == Todo && d.Ready:
		next = "atrium task run " + t.ID
	case t.Status == Todo && len(d.Broken) > 0:
		next = h.Holder.Next // 依赖等不到了：改依赖（与等待对象判定同一条）
	case t.Stage == StageAccept && t.Status == Running:
		next = "atrium task accept " + t.ID
	case (t.Status == Todo || t.Status == Queued) && len(d.WaitingOn) > 0:
		next = "atrium task wait " + d.WaitingOn[0]
	case t.Status.Finished():
		next = "atrium task ls"
	}
	text := b.String()
	if strings.HasPrefix(next, "atrium task wait") {
		var err error
		if text, next, err = events.AsyncNext(c, strings.TrimRight(text, "\n"), next); err != nil {
			return err
		}
	}
	out := struct {
		Detail
		Holder string `json:"holder,omitempty"` // 现在在等谁（没结束的任务）
	}{d, h.Holder.Text}
	return c.Done(out, text, next)
}

func taskTree(c *cli.Ctx) error {
	path := "/api/tree"
	if len(c.Args) > 0 {
		path = "/api/tasks/" + url.PathEscape(c.Args[0]) + "/tree"
	}
	var roots []*TreeNode
	if err := c.Call("GET", path, nil, &roots); err != nil {
		return err
	}
	if len(roots) == 0 {
		return c.Done(roots, "没有没结束的顶层任务", "atrium task add <标题>")
	}
	var b strings.Builder
	next := "atrium task show " + roots[0].ID
	var walk func(n *TreeNode, depth int)
	walk = func(n *TreeNode, depth int) {
		fmt.Fprintf(&b, "%s%s  %s", strings.Repeat("  ", depth), n.ID, stateLabel(n.Task))
		switch {
		case n.Ready:
			b.WriteString("  可派")
			if !strings.HasPrefix(next, "atrium task run") {
				next = "atrium task run " + n.ID
			}
		case len(n.Broken) > 0:
			b.WriteString("  依赖的 " + BrokenText(n.Broken))
		case len(n.WaitingOn) > 0:
			b.WriteString("  等 " + strings.Join(n.WaitingOn, "、"))
		}
		b.WriteString("  " + n.Title)
		if n.Summary != nil {
			fmt.Fprintf(&b, "（%s）", n.Summary)
		}
		b.WriteString("\n")
		for _, ch := range n.Children {
			walk(ch, depth+1)
		}
	}
	for _, r := range roots {
		walk(r, 0)
	}
	return c.Done(roots, b.String(), next)
}
