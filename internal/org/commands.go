package org

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/cli"
)

var introFlags = []cli.Flag{
	{Name: "what", Value: "文字", Help: "是什么（一两句人话）"},
	{Name: "uses", Value: "文字", Help: "怎么用"},
	{Name: "now", Value: "文字", Help: "现状"},
	{Name: "next", Value: "文字", Help: "下一步"},
	{Name: "leader", Value: "aN", Help: "负责人（org edit 里给 - 清掉）"},
}

func Commands(t *cli.Table) {
	t.Group("org", "部门")
	t.Add(cli.Command{Path: "org tree", Summary: "看部门树",
		Run: func(c *cli.Ctx) error {
			var roots []*Node
			if err := c.Call("GET", "/api/org", nil, &roots); err != nil {
				return err
			}
			if len(roots) == 0 {
				return c.Done(roots, "还没有部门", "atrium org add <名字>")
			}
			var b strings.Builder
			var walk func(n *Node, depth int)
			walk = func(n *Node, depth int) {
				fmt.Fprintf(&b, "%s%s  %s", strings.Repeat("  ", depth), n.ID, n.Name)
				if n.What != "" {
					fmt.Fprintf(&b, " — %s", n.What)
				}
				if n.Leader != "" {
					fmt.Fprintf(&b, "（负责人 %s）", n.Leader)
				}
				fmt.Fprintf(&b, "  要点 %d/%d\n", n.Points, MaxPoints)
				for _, ch := range n.Children {
					walk(ch, depth+1)
				}
			}
			for _, r := range roots {
				walk(r, 0)
			}
			return c.Done(roots, b.String(), "atrium org show "+roots[0].ID)
		}})
	t.Add(cli.Command{Path: "org show", Args: "<oN>", Summary: "看一个部门：介绍、仓库、下属、要点链",
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<oN>")
			if err != nil {
				return err
			}
			var s Show
			if err := c.Call("GET", "/api/org/"+url.PathEscape(id), nil, &s); err != nil {
				return err
			}
			d := s.Dept
			var b strings.Builder
			fmt.Fprintf(&b, "%s %s（%s）\n", d.ID, d.Name, strings.Join(s.Path, " / "))
			for _, kv := range [][2]string{{"是什么", d.What}, {"怎么用", d.Uses}, {"现状", d.Now}, {"下一步", d.Next},
				{"负责人", d.Leader}, {"仓库", strings.Join(d.Repos, "、")}} {
				if kv[1] != "" {
					fmt.Fprintf(&b, "%s：%s\n", kv[0], kv[1])
				}
			}
			if len(s.Children) > 0 {
				b.WriteString("\n下属：\n")
				for _, ch := range s.Children {
					fmt.Fprintf(&b, "  %s %s\n", ch.ID, ch.Name)
				}
			}
			fmt.Fprintf(&b, "\n要点（%d/%d）：", len(s.Points), MaxPoints)
			if len(s.Points) == 0 {
				b.WriteString("无")
			}
			b.WriteString("\n")
			for _, p := range s.Points {
				fmt.Fprintf(&b, "  %d. %s\n", p.Pos, ChainLine(p))
			}
			if len(s.Inherited) > 0 {
				b.WriteString("\n继承的要点：\n")
				for _, p := range s.Inherited {
					fmt.Fprintf(&b, "  %s\n", ChainLine(p))
				}
			}
			next := "atrium point add " + d.ID + " <一句话>"
			if s.Room == 0 {
				next = "atrium point edit <kN> --text <合并后的一句话>"
			}
			return c.Done(s, b.String(), next)
		}})
	t.Add(cli.Command{Path: "org add", Args: "<名字>", Summary: "建部门",
		Flags: append([]cli.Flag{
			{Name: "parent", Value: "oN", Help: "上级部门（不给就是顶层）"},
			{Name: "repo", Value: "仓库", Multi: true, Help: "这个部门管的仓库"},
		}, introFlags...),
		Run: func(c *cli.Ctx) error {
			name, err := c.Arg(0, "<名字>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			in := NewDept{Name: name, Parent: c.Str("parent"), What: c.Str("what"), Uses: c.Str("uses"),
				Now: c.Str("now"), Next: c.Str("next"), Leader: c.Str("leader"), Repos: c.List("repo")}
			var d Dept
			if err := c.Call("POST", "/api/org", in, &d); err != nil {
				return err
			}
			return c.Done(d, fmt.Sprintf("已建部门 %s %s", d.ID, d.Name), "atrium point add "+d.ID+" <一句话>")
		}})
	t.Add(cli.Command{Path: "org edit", Args: "<oN>", Summary: "改部门：名字、上级、介绍、负责人、仓库",
		Flags: append([]cli.Flag{
			{Name: "name", Value: "名字", Help: "改名"},
			{Name: "parent", Value: "oN", Help: "挪到别的上级下（给 - 挪到顶层）"},
			{Name: "repo-add", Value: "仓库", Multi: true, Help: "加仓库"},
			{Name: "repo-rm", Value: "仓库", Multi: true, Help: "去掉仓库"},
		}, introFlags...),
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<oN>")
			if err != nil {
				return err
			}
			p := DeptPatch{Name: c.Opt("name"), Parent: c.Opt("parent"), What: c.Opt("what"), Uses: c.Opt("uses"),
				Now: c.Opt("now"), Next: c.Opt("next"), Leader: c.Opt("leader"),
				RepoAdd: c.List("repo-add"), RepoDrop: c.List("repo-rm")}
			var d Dept
			if err := c.Call("PATCH", "/api/org/"+url.PathEscape(id), p, &d); err != nil {
				return err
			}
			return c.Done(d, fmt.Sprintf("已改部门 %s %s", d.ID, d.Name), "atrium org show "+d.ID)
		}})

	t.Group("point", "要点")
	t.Add(cli.Command{Path: "point add", Args: "<oN> <一句话>", Summary: fmt.Sprintf("给部门加一条要点（每部门上限 %d 条）", MaxPoints),
		Flags: []cli.Flag{
			{Name: "why", Value: "文字", Help: "为什么"},
			{Name: "by", Value: "谁定的", Help: "缺省是你"},
			{Name: "check", Value: "检查", Help: "守护它的检查：测试文件与用例名，或 $ 开头的命令"},
			{Name: "pos", Value: "N", Help: "排第几（1 最重要；缺省排最后）"},
		},
		Run: func(c *cli.Ctx) error {
			dept, err := c.Arg(0, "<oN>")
			if err != nil {
				return err
			}
			text, err := c.Arg(1, "<一句话>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(2); err != nil {
				return err
			}
			pos, err := c.Int("pos", 0)
			if err != nil {
				return err
			}
			in := NewPoint{Text: text, Why: c.Str("why"), By: c.Str("by"), Check: c.Str("check"), Pos: pos}
			var p Point
			if err := c.Call("POST", "/api/org/"+url.PathEscape(dept)+"/points", in, &p); err != nil {
				return err
			}
			return c.Done(p, fmt.Sprintf("已加要点 %s（%s 第 %d 条）：%s", p.ID, p.Org, p.Pos, p.Text), "atrium org show "+p.Org)
		}})
	t.Add(cli.Command{Path: "point edit", Args: "<kN>", Summary: "改、挪或删一条要点",
		Flags: []cli.Flag{
			{Name: "text", Value: "文字", Help: "改这句话"},
			{Name: "why", Value: "文字", Help: "为什么"},
			{Name: "by", Value: "谁定的", Help: "谁定的"},
			{Name: "check", Value: "检查", Help: "守护它的检查（给空串清掉）"},
			{Name: "pos", Value: "N", Help: "挪到第几"},
			{Name: "delete", Bool: true, Help: "删掉这条"},
		},
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<kN>")
			if err != nil {
				return err
			}
			p := PointPatch{Text: c.Opt("text"), Why: c.Opt("why"), By: c.Opt("by"), Check: c.Opt("check"), Delete: c.Bool("delete")}
			if c.Has("pos") {
				pos, err := c.Int("pos", 0)
				if err != nil {
					return err
				}
				p.Pos = &pos
			}
			var pt Point
			if err := c.Call("PATCH", "/api/points/"+url.PathEscape(id), p, &pt); err != nil {
				return err
			}
			msg := fmt.Sprintf("已改要点 %s（%s 第 %d 条）：%s", pt.ID, pt.Org, pt.Pos, pt.Text)
			if p.Delete {
				msg = fmt.Sprintf("已删要点 %s：%s", pt.ID, pt.Text)
			}
			return c.Done(pt, msg, "atrium org show "+pt.Org)
		}})
	identityCommands(t)
}
