package ledger

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/cli"
)

func Commands(t *cli.Table) {
	t.Group("task", "任务")
	t.Add(cli.Command{Path: "task add", Args: "<标题>", Summary: "建任务",
		Flags: []cli.Flag{
			{Name: "detail", Value: "文字", Help: "详述：要做成什么、怎么算做完"},
			{Name: "org", Value: "oN", Help: "所属部门（缺省沿用父任务的）"},
			{Name: "parent", Value: "tN", Help: "父任务"},
			{Name: "after", Value: "tN", Multi: true, Help: "依赖：这些任务完成后才能派"},
			{Name: "skill", Value: "名字", Help: "用哪个技能"},
			{Name: "priority", Value: "级别", Help: "urgent 紧急 / fix 修复 / normal 普通（缺省）/ idle 闲时"},
			{Name: "repo", Value: "仓库", Help: "在哪个仓库干活，如 owner/name"},
			{Name: "owner", Value: "身份", Help: "处理人：结果（合入、上线、失败、卡住）要处理地投给他——u1、secretary 或 aN（缺省派活的人）"},
		},
		Run: func(c *cli.Ctx) error {
			title, err := c.Arg(0, "<标题>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			in := NewTask{Title: title, Detail: c.Str("detail"), Org: c.Str("org"), Parent: c.Str("parent"),
				After: c.List("after"), Skill: c.Str("skill"), Priority: Priority(c.Str("priority")), Repo: c.Str("repo"),
				Owner: c.Str("owner")}
			var task Task
			if err := c.Call("POST", "/api/tasks", in, &task); err != nil {
				return err
			}
			return c.Done(task, fmt.Sprintf("已建 %s「%s」（%s）", task.ID, task.Title, where(task)),
				"atrium task run "+task.ID)
		}})
	t.Add(cli.Command{Path: "task ls", Summary: "列任务（缺省列没结束的）",
		Flags: []cli.Flag{
			{Name: "status", Value: "状态", Multi: true, Help: "只列这些状态：todo queued running done failed blocked cancelled"},
			{Name: "org", Value: "oN", Help: "只列这个部门的"},
			{Name: "parent", Value: "tN", Help: "只列这个任务的直接子任务"},
			{Name: "top", Bool: true, Help: "只列顶层任务"},
			{Name: "limit", Value: "条数", Help: "最多列几条（缺省 50，上限 500）"},
		},
		Run: func(c *cli.Ctx) error {
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
			if len(tasks) == 0 {
				return c.Done(tasks, "没有任务", "atrium task add <标题>")
			}
			var b strings.Builder
			for _, t := range tasks {
				fmt.Fprintf(&b, "%s  %s  %s  %s\n", t.ID, stateLabel(t), t.Priority, t.Title)
			}
			return c.Done(tasks, b.String(), "atrium task show "+tasks[0].ID)
		}})
	t.Add(cli.Command{Path: "task show", Args: "<tN>", Summary: "看一件任务：状态、依赖、子任务汇总、最近经历",
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<tN>")
			if err != nil {
				return err
			}
			var d Detail
			if err := c.Call("GET", "/api/tasks/"+url.PathEscape(id), nil, &d); err != nil {
				return err
			}
			t := d.Task
			// 没结束的任务问 watch「现在球在谁手里」（持球人判定只有一份，在 watch）。
			var h struct {
				Holder struct {
					Text string `json:"text"`
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
			for _, kv := range [][2]string{{"部门", t.Org}, {"父任务", t.Parent}, {"派活人", d.Parties.By}, {"处理人", d.Parties.Owner}} {
				if kv[1] != "" {
					fmt.Fprintf(&b, "%s：%s\n", kv[0], kv[1])
				}
			}
			for _, kv := range [][2]string{{"技能", t.Skill}, {"仓库", t.Repo}, {"执行者", t.Worker}, {"机器", t.Host}, {"PR", t.PR}} {
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
					fmt.Fprintf(&b, "  %s  %s  %s  %s\n", time.UnixMilli(e.At).Format("01-02 15:04"), e.Actor, e.Kind, oneLine(e.Body))
				}
			}
			out := struct {
				Detail
				Holder string `json:"holder,omitempty"` // 现在谁拿着球（没结束的任务）
			}{d, h.Holder.Text}
			return c.Done(out, b.String(), showNext(t, d.Ready, d.WaitingOn))
		}})
	t.Add(cli.Command{Path: "task set", Args: "<tN>", Summary: "改任务的描述、依赖或状态",
		Flags: []cli.Flag{
			{Name: "title", Value: "文字", Help: "标题"},
			{Name: "detail", Value: "文字", Help: "详述"},
			{Name: "priority", Value: "级别", Help: "urgent / fix / normal / idle"},
			{Name: "org", Value: "oN", Help: "改所属部门（给空串清掉）"},
			{Name: "skill", Value: "名字", Help: "技能（给空串清掉）"},
			{Name: "repo", Value: "仓库", Help: "仓库"},
			{Name: "after", Value: "tN", Multi: true, Help: "整体替换依赖（给空串清空）"},
			{Name: "status", Value: "状态", Help: "人工改状态：todo、done、failed、cancelled（停下用 task stop）"},
			{Name: "note", Value: "文字", Help: "改状态的原因，记进经历"},
		},
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<tN>")
			if err != nil {
				return err
			}
			body := SetBody{Patch: Patch{Title: c.Opt("title"), Detail: c.Opt("detail"), Org: c.Opt("org"),
				Skill: c.Opt("skill"), Repo: c.Opt("repo")}, Note: c.Str("note")}
			if p := c.Opt("priority"); p != nil {
				pr := Priority(*p)
				body.Priority = &pr
			}
			if c.Has("after") {
				after := c.List("after")
				if after == nil {
					after = []string{}
				}
				body.After = &after
			}
			if s := c.Opt("status"); s != nil {
				if Status(*s) == Blocked {
					return api.Usage("--status: 停下用 atrium task stop %s [原因]", id)
				}
				st := Status(*s)
				body.Status = &st
			}
			var t Task
			if err := c.Call("PATCH", "/api/tasks/"+url.PathEscape(id), body, &t); err != nil {
				return err
			}
			return c.Done(t, fmt.Sprintf("已改 %s「%s」：%s", t.ID, t.Title, stateLabel(t)), "atrium task show "+t.ID)
		}})
	t.Add(cli.Command{Path: "task stop", Args: "<tN> [原因]", Summary: "停下任务：结束在跑的执行者，转受阻（再派用 task run）",
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<tN>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(2); err != nil {
				return err
			}
			st := Blocked
			body := SetBody{Status: &st, Note: "停下"}
			if len(c.Args) == 2 {
				body.Note = "停下：" + c.Args[1]
			}
			var t Task
			if err := c.Call("PATCH", "/api/tasks/"+url.PathEscape(id), body, &t); err != nil {
				return err
			}
			return c.Done(t, fmt.Sprintf("已停下 %s「%s」：%s；在跑的执行者由派活循环结束", t.ID, t.Title, stateLabel(t)), "atrium task run "+t.ID)
		}})
	t.Add(cli.Command{Path: "task tree", Args: "[tN]", Summary: "看任务树与各层汇总（不给 tN 看全部顶层没结束的）",
		Run: func(c *cli.Ctx) error {
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
			var walk func(n *TreeNode, depth int)
			walk = func(n *TreeNode, depth int) {
				fmt.Fprintf(&b, "%s%s  %s  %s", strings.Repeat("  ", depth), n.ID, stateLabel(n.Task), n.Title)
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
			return c.Done(roots, b.String(), "atrium task plan "+roots[0].ID)
		}})
	t.Add(cli.Command{Path: "task plan", Args: "<tN>", Summary: "排子任务的先后：哪些现在能派、哪些在等谁",
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<tN>")
			if err != nil {
				return err
			}
			var rows []PlanRow
			if err := c.Call("GET", "/api/tasks/"+url.PathEscape(id)+"/plan", nil, &rows); err != nil {
				return err
			}
			var b strings.Builder
			next := "atrium task wait " + id
			for _, r := range rows {
				state := string(r.Status)
				switch {
				case r.Ready:
					state = "可派"
					if strings.HasPrefix(next, "atrium task wait") {
						next = "atrium task run " + r.ID
					}
				case len(r.WaitingOn) > 0 && r.Status == Todo:
					state = "等 " + strings.Join(r.WaitingOn, "、")
				}
				step := "已结束"
				if r.Step > 0 {
					step = "第 " + strconv.Itoa(r.Step) + " 步"
				}
				fmt.Fprintf(&b, "%s  %s  %s  %s\n", step, r.ID, state, r.Title)
			}
			return c.Done(rows, b.String(), next)
		}})
	t.Add(cli.Command{Path: "task note", Args: "<tN> <文字>", Summary: "给任务加一条备注（记进经历，执行者看不到；要捎给它用 task tell）",
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<tN>")
			if err != nil {
				return err
			}
			text, err := c.Arg(1, "<文字>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(2); err != nil {
				return err
			}
			if err := c.Call("POST", "/api/tasks/"+url.PathEscape(id)+"/notes", map[string]string{"text": text}, nil); err != nil {
				return err
			}
			return c.Done(map[string]string{"task": id}, "已记到 "+id, "atrium task show "+id)
		}})
	t.Add(cli.Command{Path: "task wait", Args: "<tN>", Summary: "等任务到某些状态（服务端长轮询，不用自己轮询）",
		Flags: []cli.Flag{
			{Name: "until", Value: "状态", Multi: true, Help: "等到这些状态之一（缺省 done、failed、blocked、cancelled）"},
			{Name: "timeout", Value: "秒", Help: "最多等多久（缺省 600，上限 3600）"},
		},
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<tN>")
			if err != nil {
				return err
			}
			q := url.Values{}
			if u := c.List("until"); len(u) > 0 {
				q.Set("until", strings.Join(u, ","))
			}
			setIf(q, "timeout", c.Str("timeout"))
			var res WaitResult
			if err := callSurvivingRestart(c, "/api/tasks/"+url.PathEscape(id)+"/wait?"+q.Encode(), &res); err != nil {
				return err
			}
			if !res.Reached {
				return (&api.Error{Code: "timeout", Message: fmt.Sprintf("等到超时，%s 仍是 %s", id, stateLabel(res.Task))}).
					WithNext("atrium task wait " + id)
			}
			return c.Done(res, fmt.Sprintf("%s「%s」：%s", id, res.Task.Title, stateLabel(res.Task)), "atrium task show "+id)
		}})
}

// callSurvivingRestart：服务平滑重启时长轮询会被打断（restarting）或短暂连不上，等新服务起来后重发。
func callSurvivingRestart(c *cli.Ctx, path string, out any) error {
	deadline := time.Now().Add(30 * time.Second)
	for {
		err := c.Call("GET", path, nil, out)
		var ae *api.Error
		if !errors.As(err, &ae) || (ae.Code != "restarting" && ae.Code != "not_running") || time.Now().After(deadline) {
			return err
		}
		time.Sleep(300 * time.Millisecond)
		c.ResetClient()
	}
}

// showNext：task show 之后该敲哪一条。能再派的状态（与 Enqueue 接受的一致：可派的
// todo、blocked、failed）给再派——受阻或失败后再看一遍状态是空转；其余维持原样。
func showNext(t Task, ready bool, waitingOn []string) string {
	switch {
	case t.Status == Todo && ready:
		return "atrium task run " + t.ID
	case t.Status == Todo && len(waitingOn) > 0:
		return "atrium task wait " + waitingOn[0]
	case t.Status == Blocked || t.Status == Failed:
		return "atrium task run " + t.ID
	case t.Status.Finished():
		return "atrium task ls"
	}
	return "atrium task wait " + t.ID
}

func stateLabel(t Task) string {
	if t.Stage == StageNone {
		return string(t.Status)
	}
	return string(t.Status) + "/" + string(t.Stage)
}

func where(t Task) string {
	parts := []string{string(t.Status)}
	if t.Org != "" {
		parts = append(parts, "部门 "+t.Org)
	}
	if t.Parent != "" {
		parts = append(parts, "父任务 "+t.Parent)
	}
	return strings.Join(parts, "，")
}

func setIf(q url.Values, k, v string) {
	if v != "" {
		q.Set(k, v)
	}
}

func oneLine(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if r := []rune(s); len(r) > 80 {
		return string(r[:80]) + "…"
	}
	return s
}
