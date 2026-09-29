// Package agenda 是组织里会生成任务的两样东西：选项单（用户拍板后建任务）与周期任务（到点建任务并派发）。
// 它要调 ledger 建任务，所以与 org 分开：org 被 events 引用（投递对象），org 再引用 ledger 会成环。
package agenda

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
)

func Module() app.Module {
	return app.Module{Name: "agenda", Commands: Commands, Routes: Routes, Run: Run}
}

type pickBody struct {
	Picks []int  `json:"picks"`
	Note  string `json:"note"`
}

// ScheduleRun 是 schedule run 的结果。
type ScheduleRun struct {
	Schedule Schedule    `json:"schedule"`
	Task     ledger.Task `json:"task"`
}

func Routes(r *api.Router, env *app.Env) {
	db := env.DB
	r.Handle("GET /api/choices", func(q *api.Req) (any, error) {
		v := q.URL.Query()
		return Choices(q.Context(), db, v.Get("node"), v.Get("all") == "1")
	})
	r.Handle("GET /api/choices/{id}", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "c")
		if err != nil {
			return nil, err
		}
		return GetChoice(q.Context(), db, id)
	})
	r.Handle("POST /api/choices", func(q *api.Req) (any, error) {
		var in ChoiceInput
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return AddChoice(q.Context(), db, in, "", q.Actor.ID)
	})
	r.Handle("POST /api/choices/{id}/decide", func(q *api.Req) (any, error) {
		if err := org.CheckUser(q.Actor, "拍板"); err != nil {
			return nil, err
		}
		id, err := q.Ref("id", "c")
		if err != nil {
			return nil, err
		}
		var in pickBody
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return Decide(q.Context(), db, id, in.Picks, in.Note, q.Actor.ID)
	})

	r.Handle("GET /api/schedules", func(q *api.Req) (any, error) {
		return Schedules(q.Context(), db, q.URL.Query().Get("node"))
	})
	r.Handle("POST /api/schedules", func(q *api.Req) (any, error) {
		var in NewSchedule
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return AddSchedule(q.Context(), db, env.Paths.Data, in, q.Actor.ID, time.Now().UnixMilli(), time.Local)
	})
	r.Handle("DELETE /api/schedules/{id}", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "s")
		if err != nil {
			return nil, err
		}
		return RemoveSchedule(q.Context(), db, id)
	})
	r.Handle("POST /api/schedules/{id}/run", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "s")
		if err != nil {
			return nil, err
		}
		t, err := RunNow(q.Context(), env, id, time.Local)
		if err != nil && t.ID == "" {
			return nil, err
		}
		x, gerr := GetSchedule(q.Context(), db, id)
		if gerr != nil {
			return nil, gerr
		}
		if err != nil {
			return nil, api.Conflict("%s 已生成 %s，但%v", id, t.ID, err).WithNext("atrium task run " + t.ID)
		}
		return ScheduleRun{Schedule: x, Task: t}, nil
	})
}

func choiceText(c Choice) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s「%s」（%s，%s）\n", c.ID, c.Title, c.Org, statusText(c.Status))
	for _, o := range c.Options {
		mark := "  "
		if containsInt(c.Recommend, o.Pos) {
			mark = "★ "
		}
		fmt.Fprintf(&b, "\n%s%d. %s\n", mark, o.Pos, o.Title)
		if o.Org != "" && o.Org != c.Org {
			fmt.Fprintf(&b, "   归属部门：%s\n", o.Org)
		}
		for _, kv := range [][2]string{{"能多做到", o.Gain}, {"为什么现在", o.WhyNow}, {"代价", o.Cost}, {"不做会怎样", o.IfNot}, {"依据", o.Evidence}} {
			fmt.Fprintf(&b, "   %s：%s\n", kv[0], kv[1])
		}
		if o.Task != "" {
			fmt.Fprintf(&b, "   已建任务：%s\n", o.Task)
		} else if c.Status != "open" {
			b.WriteString("   这轮没选\n")
		}
	}
	fmt.Fprintf(&b, "\n推荐 %s：%s\n", strings.Trim(strings.ReplaceAll(fmt.Sprint(c.Recommend), " ", "、"), "[]"), c.Reason)
	if c.Note != "" {
		fmt.Fprintf(&b, "用户说明：%s\n", c.Note)
	}
	return b.String()
}

func statusText(s string) string {
	return map[string]string{"open": "等你拍板", "picked": "已选", "passed": "这轮不做"}[s]
}

func containsInt(v []int, n int) bool {
	for _, x := range v {
		if x == n {
			return true
		}
	}
	return false
}

func parsePicks(list []string) ([]int, error) {
	out := []int{}
	for _, s := range list {
		n, err := strconv.Atoi(s)
		if err != nil {
			return nil, api.Usage("选第几项应为数字，收到 %q", s)
		}
		out = append(out, n)
	}
	return out, nil
}

func scheduleLine(x Schedule) string {
	when := "每 " + x.Every
	if x.At != "" {
		when += " " + x.At
	}
	s := fmt.Sprintf("%s  %s  %s  %s  %s  下一轮 %s", x.ID, x.Org, Kinds[x.Kind], when, x.Title,
		time.UnixMilli(x.NextAt).Local().Format("01-02 15:04"))
	if x.LastTask != "" {
		s += "  上一轮 " + x.LastTask
	}
	if x.LastNote != "" {
		s += "  〔" + x.LastNote + "〕"
	}
	return s
}

func Commands(t *cli.Table) {
	t.Group("choice", "选项单")
	t.Add(cli.Command{Path: "choice ls", Args: "[cN]", Summary: "列等拍板的选项单；给 cN 看全文",
		Flags: []cli.Flag{
			{Name: "node", Value: "oN", Help: "只看这个部门的"},
			{Name: "all", Bool: true, Help: "含已拍板的"},
		},
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			if len(c.Args) == 1 {
				var ch Choice
				if err := c.Call("GET", "/api/choices/"+url.PathEscape(c.Args[0]), nil, &ch); err != nil {
					return err
				}
				next := fmt.Sprintf("atrium choice pick %s <第几项,…> --note <原因>", ch.ID)
				if ch.Status != "open" {
					next = "atrium choice ls --all --node " + ch.Org
				}
				return c.Done(ch, choiceText(ch), next)
			}
			v := url.Values{}
			if n := c.Str("node"); n != "" {
				v.Set("node", n)
			}
			if c.Bool("all") {
				v.Set("all", "1")
			}
			var list []Choice
			if err := c.Call("GET", "/api/choices?"+v.Encode(), nil, &list); err != nil {
				return err
			}
			if len(list) == 0 {
				return c.Done(list, "没有等拍板的选项单", "")
			}
			var b strings.Builder
			for _, ch := range list {
				fmt.Fprintf(&b, "  %s  %s  %s「%s」 %d 项\n", ch.ID, ch.Org, statusText(ch.Status), ch.Title, len(ch.Options))
			}
			return c.Done(list, b.String(), "atrium choice ls "+list[0].ID)
		}})
	t.Add(cli.Command{Path: "choice add", Args: "<oN> <choice.json>", Summary: "登记一份选项单（格式同调研任务的 choice.json）",
		Run: func(c *cli.Ctx) error {
			dept, err := c.Arg(0, "<oN>")
			if err != nil {
				return err
			}
			file, err := c.Arg(1, "<choice.json>")
			if err != nil {
				return err
			}
			raw, err := os.ReadFile(file)
			if err != nil {
				return api.Usage("读不到 %s：%v", file, err)
			}
			var in ChoiceInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return api.Usage("%s 不是合法 JSON：%v", file, err)
			}
			in.Org = dept
			var ch Choice
			if err := c.Call("POST", "/api/choices", in, &ch); err != nil {
				return err
			}
			return c.Done(ch, fmt.Sprintf("已登记选项单 %s「%s」（%d 项），等用户拍板", ch.ID, ch.Title, len(ch.Options)), "atrium choice ls "+ch.ID)
		}})
	t.Add(cli.Command{Path: "choice pick", Args: "<cN> <第几项,…>", Summary: "拍板：选中的各建一件任务，没选的记「这轮不做」；--none 整份这轮都不做（只有用户）",
		Flags: []cli.Flag{{Name: "note", Value: "文字", Help: "原因或补充要求（留在选项单上、附进任务）"},
			{Name: "none", Bool: true, Help: "这轮整份都不做"}},
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<cN>")
			if err != nil {
				return err
			}
			if c.Bool("none") {
				if err := c.MaxArgs(1); err != nil {
					return err
				}
				var ch Choice
				if err := c.Call("POST", "/api/choices/"+url.PathEscape(id)+"/decide", pickBody{nil, c.Str("note")}, &ch); err != nil {
					return err
				}
				return c.Done(ch, ch.ID+" 这轮不做", "atrium choice ls")
			}
			if _, err := c.Arg(1, "<第几项,…>"); err != nil {
				return err
			}
			var list []string
			for _, a := range c.Args[1:] {
				list = append(list, strings.Split(a, ",")...)
			}
			picks, err := parsePicks(list)
			if err != nil {
				return err
			}
			var ch Choice
			if err := c.Call("POST", "/api/choices/"+url.PathEscape(id)+"/decide", pickBody{picks, c.Str("note")}, &ch); err != nil {
				return err
			}
			var made []string
			for _, o := range ch.Options {
				if o.Task != "" {
					made = append(made, fmt.Sprintf("%s「%s」", o.Task, o.Title))
				}
			}
			text, first := fmt.Sprintf("已拍板 %s\n建了任务：%s", ch.ID, strings.Join(made, "、")), ch.Options[picks[0]-1].Task
			var d struct {
				Parties ledger.Parties `json:"parties"`
			}
			if err := c.Call("GET", "/api/tasks/"+url.PathEscape(first), nil, &d); err != nil {
				return err
			}
			if owner := d.Parties.Owner; api.IsRef(owner, "a") {
				// 交给了部门负责人：由它设计方案、拆活、派活，拍板的人等结果。
				text, next, err := events.AsyncNext(c, text+"\n已交给负责人 "+owner+" 去设计、拆活", "atrium task wait "+first)
				if err != nil {
					return err
				}
				return c.Done(ch, text, next)
			}
			return c.Done(ch, text, "atrium task run "+first)
		}})
	t.Group("schedule", "周期任务")
	t.Add(cli.Command{Path: "schedule add", Args: "<oN> <标题>", Summary: fmt.Sprintf("到点在部门下生成一件任务并派发（每部门上限 %d 条）", org.MaxSchedules),
		Flags: []cli.Flag{
			{Name: "every", Value: "周期", Help: "7d、1d、12h、2w（至少 1h）"},
			{Name: "at", Value: "HH:MM", Help: "本机钟点（只给整天的周期）"},
			{Name: "kind", Value: "种类", Help: "task 自定义（缺省）/ patrol 体验巡检 / research 调研（写 choice.json 出选项单）"},
			{Name: "detail", Value: "文字", Help: "每轮任务的详述"},
			{Name: "skill", Value: "名字", Help: "每轮任务用的技能"},
		},
		Run: func(c *cli.Ctx) error {
			dept, err := c.Arg(0, "<oN>")
			if err != nil {
				return err
			}
			title, err := c.Arg(1, "<标题>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(2); err != nil {
				return err
			}
			if c.Str("every") == "" {
				return api.Usage("--every: 不能为空（如 7d）")
			}
			in := NewSchedule{Org: dept, Title: title, Kind: c.Str("kind"), Every: c.Str("every"), At: c.Str("at"),
				Detail: c.Str("detail"), Skill: c.Str("skill")}
			var x Schedule
			if err := c.Call("POST", "/api/schedules", in, &x); err != nil {
				return err
			}
			return c.Done(x, "已建周期任务 "+scheduleLine(x), "atrium schedule run "+x.ID)
		}})
	t.Add(cli.Command{Path: "schedule ls", Summary: "列周期任务：下一轮、上一轮、最近一笔",
		Flags: []cli.Flag{{Name: "node", Value: "oN", Help: "只看这个部门的"}},
		Run: func(c *cli.Ctx) error {
			var list []Schedule
			if err := c.Call("GET", "/api/schedules?node="+url.QueryEscape(c.Str("node")), nil, &list); err != nil {
				return err
			}
			if len(list) == 0 {
				return c.Done(list, "没有周期任务", "atrium schedule add <oN> <标题> --every 7d")
			}
			var b strings.Builder
			for _, x := range list {
				b.WriteString("  " + scheduleLine(x) + "\n")
			}
			return c.Done(list, b.String(), "atrium schedule run "+list[0].ID)
		}})
	t.Add(cli.Command{Path: "schedule rm", Args: "<sN>", Summary: "删周期任务（已生成的任务不动）",
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<sN>")
			if err != nil {
				return err
			}
			var x Schedule
			if err := c.Call("DELETE", "/api/schedules/"+url.PathEscape(id), nil, &x); err != nil {
				return err
			}
			return c.Done(x, "已删周期任务 "+x.ID+" "+x.Title, "atrium schedule ls --node "+x.Org)
		}})
	t.Add(cli.Command{Path: "schedule run", Args: "<sN>", Summary: "马上生成一轮并派发（不改下一轮时间）",
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<sN>")
			if err != nil {
				return err
			}
			var res ScheduleRun
			if err := c.Call("POST", "/api/schedules/"+url.PathEscape(id)+"/run", nil, &res); err != nil {
				return err
			}
			text, next, err := events.AsyncNext(c, fmt.Sprintf("%s 生成了 %s「%s」并已派发", id, res.Task.ID, res.Task.Title), "atrium task wait "+res.Task.ID)
			if err != nil {
				return err
			}
			return c.Done(res, text, next)
		}})
}
