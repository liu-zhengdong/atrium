package ledger

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/events"
)

// ContinuePRHowTo 是命令帮助与负责人提示词共用的续做入口说明。
const ContinuePRHowTo = "续做已有 PR 回原任务，不另建任务：task show tN 核对 PR；执行者在跑时 task tell tN 续做说明；等验收或已结束时先 task set tN --status todo，再 task tell tN 续做说明、task run tN（沿用原分支）"

func Commands(t *cli.Table) {
	t.Group("task", "任务")
	t.Add(cli.Command{Path: "task add", Args: "<标题>", Summary: "建任务；" + ContinuePRHowTo,
		Flags: []cli.Flag{
			{Name: "detail", Value: "文字", Help: "详述：要做成什么、怎么算做完"},
			{Name: "org", Value: "oN", Help: "所属部门（缺省沿用父任务的）"},
			{Name: "parent", Value: "tN", Help: "父任务"},
			{Name: "after", Value: "tN", Multi: true, Help: "依赖：这些任务完成后才能派"},
			{Name: "skill", Value: "名字", Help: "用哪个技能"},
			{Name: "priority", Value: "级别", Help: "urgent 紧急 / fix 修复 / normal 普通（缺省）/ idle 闲时"},
			{Name: "repo", Value: "仓库", Help: "在哪个仓库干活，如 owner/name（建工作树，交 PR 或本机合入）；不写时 task run 分派任务沿用部门的仓库（部门只有一个时）"},
			{Name: "dir", Value: "路径", Help: "工作地点：本机文件夹的绝对路径，不必是 git 仓库；执行者在原地干，交付说明写在最后的回复里（与 --repo 只给一个）"},
			{Name: "owner", Value: "身份", Help: "处理人：结果（完成、上线、失败、卡住）要处理地发给他——u1、secretary 或 aN（缺省分派任务的人；u1、secretary 在有负责人的部门由负责人收）；aN 且不写仓库与工作地点 = 交给这位负责人去拆，建好就唤醒它；--detail 写清服务三个目标里的哪一个，长期方向写进部门介绍，不建成做不完的任务"},
			{Name: "draft", Bool: true, Help: "建成草稿：还没想清楚、条件还不够，不分派任务、不计时；要写部门（按部门计上限，满了由该部门负责人整理）；想清楚了 task set tN --status todo"},
			{Name: "source", Value: "来源", Help: "草稿记的发现从哪来：user 用户纠正 / org 组织发现（只给草稿）"},
			{Name: "class", Value: "类名", Help: "草稿记的发现按原因归的类，如「执行者可用性」；回执列出已有的类（只给草稿）"},
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
				Dir: c.Str("dir"), Owner: c.Str("owner"), Draft: c.Bool("draft"), Source: Source(c.Str("source")), Class: c.Str("class")}
			var task Task
			if err := c.Call("POST", "/api/tasks", in, &task); err != nil {
				return err
			}
			text, next := fmt.Sprintf("已建 %s「%s」（%s）", task.ID, task.Title, where(task)), "atrium task run "+task.ID
			switch {
			case task.Status == Draft:
				next = "atrium task set " + task.ID + " --status todo"
				if task.Class != "" {
					var classes []Class
					if err := c.Call("GET", "/api/classes", nil, &classes); err != nil {
						return err
					}
					text += "；" + classNote(task, classes)
				}
			case Assignee(task, Parties{Owner: in.Owner}, "") != "":
				// 交给负责人的任务由它拆、派、收尾，建的人不派它。
				if text, next, err = events.AsyncNext(c, text+"，已交给 "+in.Owner+" 去拆", "atrium task wait "+task.ID); err != nil {
					return err
				}
			}
			return c.Done(task, text, next)
		}})
	t.Add(cli.Command{Path: "task ls", Summary: "列任务（缺省列没结束的；草稿只给数）",
		Flags: []cli.Flag{
			{Name: "status", Value: "状态", Multi: true, Help: "只列这些状态：draft todo queued running done failed blocked cancelled"},
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
			case t.Status == Todo && d.Children != nil && d.Children.Open() > 0:
				next = "atrium task tree " + t.ID // 拆开在做的父任务：看子任务，不派它自己
			case t.Status == Todo && d.Children != nil && d.Children.Total > 0:
				next = "atrium task set " + t.ID + " --status done" // 子任务都结束了：收尾
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
		}})
	t.Add(cli.Command{Path: "task set", Args: "<tN>", Summary: "改任务的描述、依赖或状态",
		Flags: []cli.Flag{
			{Name: "title", Value: "文字", Help: "标题"},
			{Name: "detail", Value: "文字", Help: "详述；有人在做的（交给负责人拆着的、执行者在跑的）改完当一次补充说明送到（同 task tell）"},
			{Name: "priority", Value: "级别", Help: "urgent / fix / normal / idle"},
			{Name: "org", Value: "oN", Help: "改所属部门（给空串清掉）"},
			{Name: "skill", Value: "名字", Help: "技能（给空串清掉）"},
			{Name: "repo", Value: "仓库", Help: "仓库"},
			{Name: "dir", Value: "路径", Help: "工作地点（本机文件夹的绝对路径；给空串清掉）"},
			{Name: "after", Value: "tN", Multi: true, Help: "整体替换依赖（给空串清空）"},
			{Name: "source", Value: "来源", Help: "发现从哪来：user 用户纠正 / org 组织发现（给空串清掉）"},
			{Name: "class", Value: "类名", Help: "发现归的类（给空串清掉）；把写成两个名字的同一类并起来"},
			{Name: "owner", Value: "身份", Help: "改处理人：u1、secretary 或 aN（给空串回到任务分派人），记进经历；aN 且任务待派、没有仓库与工作地点 = 交给这位负责人去拆，改好就唤醒它（草稿转待派时再唤醒）"},
			{Name: "status", Value: "状态", Help: "人工改状态：draft（退回草稿）、todo（转待派）、done、failed、cancelled（停下用 task stop）"},
			{Name: "note", Value: "文字", Help: "改状态的原因，记进经历"},
		},
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<tN>")
			if err != nil {
				return err
			}
			body := SetBody{Patch: Patch{Title: c.Opt("title"), Detail: c.Opt("detail"), Org: c.Opt("org"),
				Skill: c.Opt("skill"), Repo: c.Opt("repo"), Dir: c.Opt("dir"), Owner: c.Opt("owner")}, Note: c.Str("note")}
			if p := c.Opt("priority"); p != nil {
				pr := Priority(*p)
				body.Priority = &pr
			}
			if s := c.Opt("source"); s != nil {
				src := Source(*s)
				body.Source = &src
			}
			body.Class = c.Opt("class")
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
			text, next := fmt.Sprintf("已改 %s「%s」：%s", t.ID, t.Title, stateLabel(t)), "atrium task show "+t.ID
			if o := c.Opt("owner"); o != nil && Assignee(t, Parties{Owner: *o}, "") != "" {
				// 交给负责人的任务由它拆、派、收尾，改的人不派它。
				if text, next, err = events.AsyncNext(c, text+"，已交给 "+*o+" 去拆", "atrium task wait "+t.ID); err != nil {
					return err
				}
			}
			return c.Done(t, text, next)
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
			return c.Done(t, fmt.Sprintf("已停下 %s「%s」：%s；在跑的执行者由分派任务循环结束", t.ID, t.Title, stateLabel(t)), "atrium task run "+t.ID)
		}})
	t.Add(cli.Command{Path: "task tree", Args: "[tN]", Summary: "看任务树、各层汇总与每件能派还是在等谁（不给 tN 看全部顶层没结束的）",
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
			{Name: "until", Value: "状态", Multi: true, Help: "等到这些状态之一（缺省 done、failed、blocked、cancelled，或停在等验收）"},
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
			next := "atrium task show " + id
			if res.Task.Stage == StageAccept && res.Task.Status == Running {
				next = "atrium task accept " + id
			}
			return c.Done(res, fmt.Sprintf("%s「%s」：%s", id, res.Task.Title, stateLabel(res.Task)), next)
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

// classNote 是加了带类的草稿后给的一句：类里已有几件，或这是新类、已有哪些类。
func classNote(t Task, classes []Class) string {
	var others []string
	for _, c := range classes {
		if c.Name == t.Class {
			if c.Tasks > 1 {
				return fmt.Sprintf("类「%s」里已有 %d 件（完成 %d 件）", c.Name, c.Tasks-1, c.Done)
			}
			continue
		}
		others = append(others, fmt.Sprintf("%s（%d）", c.Name, c.Tasks))
	}
	if len(others) == 0 {
		return fmt.Sprintf("「%s」是第一个类", t.Class)
	}
	return fmt.Sprintf("「%s」是新类；已有的类：%s——是同一类的改用已有名字：atrium task set %s --class 类名", t.Class,
		strings.Join(others, "、"), t.ID)
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
