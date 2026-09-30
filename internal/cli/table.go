// Package cli 是命令表：每个包在自己的 Commands(*Table) 里注册命令，--help 与分组帮助都从这里生成。
// 回执约定：成功最后一行给下一步命令；--json 时输出 {"ok":true,"result":…,"next":…}，
// 失败 {"ok":false,"error":{"code","message","next"?}}。
package cli

import (
	"fmt"
	"io"
	"strings"
)

// Flag 描述一个 --参数。Bool 不吃值；Multi 可重复（也接受逗号分隔）。
type Flag struct {
	Name  string
	Value string // 值的占位名，如 "oN"；Bool 时忽略
	Help  string
	Bool  bool
	Multi bool
}

// Command 是命令表里的一条。Path 是空格分隔的命令词，如 "task add"。
type Command struct {
	Path    string
	Args    string // 位置参数的写法，如 "<tN> <文字>"
	Summary string // 一行说明
	Detail  string // 只在这条命令的 --help 里显示的长说明（如输入文件的格式）
	Flags   []Flag
	// Local：不经服务就能完成（start、status、stop）。其余命令都经服务 HTTP 完成。
	Local  bool
	Hidden bool // 不在帮助里列出（如服务进程入口 serve）
	Run    func(c *Ctx) error
}

type group struct{ name, summary string }

type Table struct {
	Name    string // 二进制名，帮助里用
	Intro   string // 顶层帮助第一行
	Default string // 不带参数时跑的命令
	cmds    map[string]*Command
	order   []string
	groups  []group
}

func NewTable(name, intro string) *Table {
	return &Table{Name: name, Intro: intro, cmds: map[string]*Command{}}
}

// Group 声明一个命令组（如 "task"）及其一行说明。同一组可由多个包往里加命令，但只声明一次。
func (t *Table) Group(name, summary string) {
	for _, g := range t.groups {
		if g.name == name {
			panic("命令组重复声明：" + name)
		}
	}
	t.groups = append(t.groups, group{name, summary})
}

// Add 注册命令；路径重复、组未声明都是编程错误，直接 panic。
func (t *Table) Add(c Command) {
	if _, dup := t.cmds[c.Path]; dup {
		panic("命令重复注册：" + c.Path)
	}
	if words := strings.Fields(c.Path); len(words) > 1 && !t.hasGroup(words[0]) {
		panic("命令组未声明：" + words[0])
	}
	cmd := c
	t.cmds[c.Path] = &cmd
	t.order = append(t.order, c.Path)
}

func (t *Table) hasGroup(name string) bool {
	for _, g := range t.groups {
		if g.name == name {
			return true
		}
	}
	return false
}

// Lookup 按最长前缀匹配命令词，返回命令与剩下的参数。
func (t *Table) Lookup(args []string) (*Command, []string) {
	for n := min(len(args), 3); n >= 1; n-- {
		if c, ok := t.cmds[strings.Join(args[:n], " ")]; ok {
			return c, args[n:]
		}
	}
	return nil, args
}

// Commands 按注册顺序返回全部命令（生成文档或测试用）。
func (t *Table) Commands() []*Command {
	out := make([]*Command, 0, len(t.order))
	for _, p := range t.order {
		out = append(out, t.cmds[p])
	}
	return out
}

func (t *Table) writeHelp(w io.Writer) {
	fmt.Fprintf(w, "%s\n\n用法：%s <命令> [参数] [--json]\n\n", t.Intro, t.Name)
	var top []*Command
	var hidden []string
	byGroup := map[string][]*Command{}
	for _, c := range t.Commands() {
		if c.Hidden {
			hidden = append(hidden, c.Path)
			continue
		}
		if first := strings.Fields(c.Path)[0]; t.hasGroup(first) {
			byGroup[first] = append(byGroup[first], c)
		} else {
			top = append(top, c)
		}
	}
	writeList(w, t.Name, top)
	for _, g := range t.groups {
		if len(byGroup[g.name]) == 0 {
			continue // 整组都不列（如远程代理 agent）
		}
		fmt.Fprintf(w, "\n%s（%s）\n", g.summary, g.name)
		writeList(w, t.Name, byGroup[g.name])
	}
	if len(hidden) > 0 {
		fmt.Fprintf(w, "\n不列出的（程序调用或照回执抄）：%s\n", strings.Join(hidden, "、"))
	}
	fmt.Fprintf(w, "\n下一步：%s <命令> --help\n", t.Name)
}

func (t *Table) writeGroupHelp(w io.Writer, name string) {
	for _, g := range t.groups {
		if g.name == name {
			fmt.Fprintf(w, "%s（%s）\n\n", g.summary, name)
		}
	}
	var cmds []*Command
	for _, c := range t.Commands() {
		if (c.Path == name || strings.HasPrefix(c.Path, name+" ")) && !c.Hidden {
			cmds = append(cmds, c)
		}
	}
	writeList(w, t.Name, cmds)
	fmt.Fprintf(w, "\n下一步：%s %s <子命令> --help\n", t.Name, name)
}

func (t *Table) writeCommandHelp(w io.Writer, c *Command) {
	fmt.Fprintf(w, "%s\n\n用法：%s %s", c.Summary, t.Name, c.Path)
	if c.Args != "" {
		fmt.Fprintf(w, " %s", c.Args)
	}
	fmt.Fprintln(w, " [参数]")
	flags := append([]Flag{}, c.Flags...)
	flags = append(flags, Flag{Name: "json", Bool: true, Help: "输出 JSON"})
	fmt.Fprintln(w)
	width := 0
	for _, f := range flags {
		width = max(width, displayWidth(flagSig(f)))
	}
	for _, f := range flags {
		sig := flagSig(f)
		fmt.Fprintf(w, "  %s%s  %s\n", sig, strings.Repeat(" ", width-displayWidth(sig)), f.Help)
	}
	if c.Detail != "" {
		fmt.Fprintf(w, "\n%s\n", c.Detail)
	}
}

func flagSig(f Flag) string {
	s := "--" + f.Name
	if !f.Bool {
		v := f.Value
		if v == "" {
			v = "值"
		}
		s += " <" + v + ">"
	}
	if f.Multi {
		s += " …"
	}
	return s
}

func writeList(w io.Writer, bin string, cmds []*Command) {
	width := 0
	sig := func(c *Command) string {
		if c.Args == "" {
			return c.Path
		}
		return c.Path + " " + c.Args
	}
	for _, c := range cmds {
		width = max(width, displayWidth(sig(c)))
	}
	for _, c := range cmds {
		s := sig(c)
		fmt.Fprintf(w, "  %s%s  %s\n", s, strings.Repeat(" ", width-displayWidth(s)), c.Summary)
	}
}

// displayWidth 粗算终端宽度：非 ASCII 按两格。
func displayWidth(s string) int {
	n := 0
	for _, r := range s {
		if r < 0x80 {
			n++
		} else {
			n += 2
		}
	}
	return n
}
