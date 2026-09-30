package org

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/cli"
)

var asFlag = cli.Flag{Name: "as", Value: "secretary|aN", Help: "看或写谁的备忘（缺省：用户令牌是秘书的，负责人是自己的）"}

func memoPath(c *cli.Ctx) string {
	if as := c.Str("as"); as != "" {
		return "/api/memo?as=" + url.QueryEscape(as)
	}
	return "/api/memo"
}

func leaderLine(i Identity) string {
	s := fmt.Sprintf("%s %s  执行者 %s", i.ID, i.Name, strings.Join(i.Workers, ","))
	if len(i.Depts) > 0 {
		s += "  负责 " + strings.Join(i.Depts, "、")
	} else {
		s += "  还没负责部门"
	}
	return s
}

func identityCommands(t *cli.Table) {
	t.Group("leader", "负责人")
	t.Add(cli.Command{Path: "leader add", Args: "<名字>", Summary: "登记负责人（aN）",
		Flags: []cli.Flag{{Name: "workers", Value: "执行者", Multi: true, Help: "执行者组合：唤醒时按顺序轮换，写法同 task run --worker（工具+模型[:强度]）；负责人不给时沿用自己的组合"},
			{Name: "org", Value: "oN", Help: "一步绑定到这个部门（负责人登记时必填）"}},
		Run: func(c *cli.Ctx) error {
			name, err := c.Arg(0, "<名字>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			var i Identity
			if err := c.Call("POST", "/api/leaders", NewLeader{Name: name, Workers: c.List("workers"), Dept: c.Str("org")}, &i); err != nil {
				return err
			}
			next := "atrium org edit <oN> --leader " + i.ID
			if c.Str("org") != "" {
				next = "atrium leader ls " + i.ID
			}
			return c.Done(i, "已登记负责人 "+leaderLine(i), next)
		}})
	t.Add(cli.Command{Path: "leader edit", Args: "<aN>", Summary: "改负责人的名字或执行者组合；--delete 删掉",
		Flags: []cli.Flag{
			{Name: "name", Value: "名字", Help: "改名"},
			{Name: "workers", Value: "执行者", Multi: true, Help: "换执行者组合（整组替换，写法同 task run --worker）"},
			{Name: "delete", Bool: true, Help: "删掉这位负责人（连同备忘）；还负责部门或有没确认的事件时拒绝并列出"},
		},
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<aN>")
			if err != nil {
				return err
			}
			p := LeaderPatch{Name: c.Opt("name"), Delete: c.Bool("delete")}
			if c.Has("workers") {
				w := c.List("workers")
				p.Workers = &w
			}
			var i Identity
			if err := c.Call("PATCH", "/api/leaders/"+url.PathEscape(id), p, &i); err != nil {
				return err
			}
			if p.Delete {
				return c.Done(i, fmt.Sprintf("已删负责人 %s %s（连同备忘）", i.ID, i.Name), "atrium leader ls")
			}
			return c.Done(i, "已改负责人 "+leaderLine(i), "atrium leader ls "+i.ID)
		}})
	t.Add(cli.Command{Path: "leader ls", Args: "[aN]", Summary: "看全部负责人，或一位的详情与备忘",
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			if len(c.Args) == 1 {
				var s LeaderShow
				if err := c.Call("GET", "/api/leaders/"+url.PathEscape(c.Args[0]), nil, &s); err != nil {
					return err
				}
				memo := s.Memo.Body
				if memo == "" {
					memo = "（空）"
				}
				text := fmt.Sprintf("%s\n\n备忘（%d/%d 字）：\n%s", leaderLine(s.Identity),
					utf8.RuneCountInString(s.Memo.Body), MaxMemo, memo)
				return c.Done(s, text, "atrium memo edit <文本> --as "+s.ID)
			}
			var list []Identity
			if err := c.Call("GET", "/api/leaders", nil, &list); err != nil {
				return err
			}
			if len(list) == 0 {
				return c.Done(list, "还没有负责人", "atrium leader add <名字> --workers claude+opus:high")
			}
			lines := make([]string, len(list))
			for k, i := range list {
				lines[k] = leaderLine(i)
			}
			return c.Done(list, strings.Join(lines, "\n"), "atrium leader ls "+list[0].ID)
		}})

	t.Group("memo", "备忘")
	t.Add(cli.Command{Path: "memo show", Summary: "看备忘（秘书或负责人各一份）", Flags: []cli.Flag{asFlag},
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(0); err != nil {
				return err
			}
			var m Memo
			if err := c.Call("GET", memoPath(c), nil, &m); err != nil {
				return err
			}
			body := m.Body
			if body == "" {
				body = "（空）"
			}
			return c.Done(m, fmt.Sprintf("%s 的备忘（%s 字）：\n%s", m.Owner, Tally("memo", utf8.RuneCountInString(m.Body)), body),
				"atrium memo edit <文本>"+asSuffix(c))
		}})
	t.Add(cli.Command{Path: "memo edit", Args: "[文本]", Summary: fmt.Sprintf("覆盖写备忘（上限 %d 字，超了先精简）", MaxMemo),
		Flags: []cli.Flag{{Name: "file", Value: "路径", Help: "从文件读全文"}, asFlag},
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			var body string
			switch {
			case c.Has("file") && len(c.Args) == 1:
				return api.Usage("文本与 --file 只给一个")
			case c.Has("file"):
				raw, err := os.ReadFile(c.Str("file"))
				if err != nil {
					return api.Usage("--file: %v", err)
				}
				body = string(raw)
			case len(c.Args) == 1:
				body = c.Args[0]
			default:
				return api.Usage("缺少 [文本] 或 --file").WithNext("atrium memo edit --help")
			}
			var m Memo
			if err := c.Call("PUT", memoPath(c), memoBody{Body: body}, &m); err != nil {
				return err
			}
			return c.Done(m, fmt.Sprintf("已写 %s 的备忘（%d/%d 字）", m.Owner, utf8.RuneCountInString(m.Body), MaxMemo),
				"atrium memo show"+asSuffix(c))
		}})
}

func asSuffix(c *cli.Ctx) string {
	if as := c.Str("as"); as != "" {
		return " --as " + as
	}
	return ""
}
