// Package importer 是一次性的旧库导入（atrium import）：从 TS 版 atrium.sqlite 只读搬出有价值的判断——
// 部门、要点、决定、负责人与备忘、技能、资料、执行者档案、机器登记；任务历史不搬。
// 本文件只有纯判定（吃旧行、吐新行与跳过原因），IO 在 importer.go。
package importer

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/org"
)

// 上限取 org 的上限表；超了照样导入，回执列出由用户整理。部门介绍的字数上限 org 没导出，这里照抄一份。
const maxIntro = 300

type oldNode struct {
	ID       int64
	Parent   *int64
	Name     string
	Archived bool
	Fields   string // org_docs.fields（charter），可空
}

// Dept 是一个要写进新库的部门。
type Dept struct {
	ID, Parent, Name, What, Uses, Now, Next string
}

// planDepts：未归档的节点按「上级在前」排好转成部门；上级已归档的整枝跳过。
// 名字取人话别名 alias（没有用 name）；介绍取 charter 的 what/uses/now/next（数组按行拼）。
func planDepts(nodes []oldNode) (out []Dept, skipped []string, err error) {
	byID := map[int64]oldNode{}
	for _, n := range nodes {
		byID[n.ID] = n
	}
	// 深度优先按上级在前排；判上级是否可用。
	order := append([]oldNode(nil), nodes...)
	depth := func(n oldNode) int {
		d := 0
		for p := n.Parent; p != nil; d++ {
			pn, ok := byID[*p]
			if !ok || d > len(nodes) {
				return -1
			}
			p = pn.Parent
		}
		return d
	}
	sort.SliceStable(order, func(i, j int) bool { return depth(order[i]) < depth(order[j]) })
	kept := map[int64]bool{}
	for _, n := range order {
		ref := fmt.Sprintf("o%d", n.ID)
		if n.Archived {
			skipped = append(skipped, ref+" 已归档")
			continue
		}
		if depth(n) < 0 {
			return nil, nil, fmt.Errorf("旧库 org_nodes %s 的上级链断了或成环", ref)
		}
		parent := ""
		if n.Parent != nil {
			if !kept[*n.Parent] {
				skipped = append(skipped, fmt.Sprintf("%s 上级 o%d 没导入", ref, *n.Parent))
				continue
			}
			parent = fmt.Sprintf("o%d", *n.Parent)
		}
		f, err := parseFields(n.Fields)
		if err != nil {
			return nil, nil, fmt.Errorf("旧库 %s 的 org_docs.fields：%w", ref, err)
		}
		name := f["alias"]
		if name == "" {
			name = n.Name
		}
		kept[n.ID] = true
		out = append(out, Dept{ID: ref, Parent: parent, Name: name,
			What: f["what"], Uses: f["uses"], Now: f["now"], Next: f["next"]})
	}
	return out, skipped, nil
}

// parseFields 取 charter fields 里的文字字段：字符串原样，字符串数组按行拼，其余键忽略。
func parseFields(raw string) (map[string]string, error) {
	out := map[string]string{}
	if raw == "" {
		return out, nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, err
	}
	for _, k := range []string{"alias", "what", "uses", "now", "next"} {
		v, ok := m[k]
		if !ok || string(v) == "null" {
			continue
		}
		var s string
		if json.Unmarshal(v, &s) == nil {
			out[k] = strings.TrimSpace(s)
			continue
		}
		var list []string
		if err := json.Unmarshal(v, &list); err != nil {
			return nil, fmt.Errorf("%s 既不是文字也不是文字数组", k)
		}
		out[k] = strings.Join(list, "\n")
	}
	return out, nil
}

// longIntros 列出介绍字段超过上限的部门字段（照样导入，回执提示整理）。
func longIntros(depts []Dept) []string {
	var out []string
	for _, d := range depts {
		for _, f := range []struct{ k, v string }{{"what", d.What}, {"uses", d.Uses}, {"now", d.Now}, {"next", d.Next}} {
			if n := utf8.RuneCountInString(f.v); n > maxIntro {
				out = append(out, fmt.Sprintf("%s.%s %d 字", d.ID, f.k, n))
			}
		}
	}
	return out
}

type oldPoint struct {
	ID                             int64
	Node                           int64
	Pos                            int64
	Text, Why, By, Check, UpdateBy string
	UpdatedAt                      int64
}

// Point 是要写进新库的要点（pos 从 1 起重排）。
type Point struct {
	ID, Dept                  string
	Pos                       int
	Text, Why, By, Check, UBy string
	UpdatedAt                 int64
}

// planPoints：同部门按旧 pos、再按 id 排，重排成 1..n；部门没导入的跳过；超过 7 条的部门列出来。
func planPoints(points []oldPoint, depts map[string]bool) (out []Point, skipped, over []string) {
	sorted := append([]oldPoint(nil), points...)
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.Node != b.Node {
			return a.Node < b.Node
		}
		if a.Pos != b.Pos {
			return a.Pos < b.Pos
		}
		return a.ID < b.ID
	})
	count := map[string]int{}
	var order []string
	for _, p := range sorted {
		dept := fmt.Sprintf("o%d", p.Node)
		if !depts[dept] {
			skipped = append(skipped, fmt.Sprintf("k%d 所在部门 %s 没导入", p.ID, dept))
			continue
		}
		if count[dept] == 0 {
			order = append(order, dept)
		}
		count[dept]++
		out = append(out, Point{ID: fmt.Sprintf("k%d", p.ID), Dept: dept, Pos: count[dept],
			Text: p.Text, Why: p.Why, By: p.By, Check: p.Check, UBy: p.UpdateBy, UpdatedAt: p.UpdatedAt})
	}
	for _, d := range order {
		if count[d] > org.MaxPoints {
			over = append(over, fmt.Sprintf("%s %d/%d", d, count[d], org.MaxPoints))
		}
	}
	return out, skipped, over
}

type oldDecision struct {
	ID                int64
	DecidedBy         string
	Text, Why         string
	Node              *int64
	Superseded, Settl bool
	CreatedAt         int64
}

// Decision 是要写进新库的决定。
type Decision struct {
	ID, Dept, Text, Why string
	CreatedAt           int64
}

// decisionSkip 判定一条旧决定为什么不搬（空串表示搬）：只搬用户拍板、仍然有效、没有沉淀成要点的。
func decisionSkip(d oldDecision) string {
	switch {
	case d.DecidedBy != "u1":
		return "不是用户拍板（负责人或秘书自己的决定）"
	case d.Superseded:
		return "已被推翻"
	case d.Settl:
		return "已沉淀成要点"
	}
	return ""
}

// planDecisions：没挂部门（或部门没导入）的归到根部门；每部门超过 30 条有效决定的列出来。
func planDecisions(list []oldDecision, depts map[string]bool, root string) (out []Decision, skipped map[string]int, over []string) {
	skipped = map[string]int{}
	count := map[string]int{}
	var order []string
	for _, d := range list {
		if why := decisionSkip(d); why != "" {
			skipped[why]++
			continue
		}
		dept := root
		if d.Node != nil && depts[fmt.Sprintf("o%d", *d.Node)] {
			dept = fmt.Sprintf("o%d", *d.Node)
		}
		if count[dept] == 0 {
			order = append(order, dept)
		}
		count[dept]++
		out = append(out, Decision{ID: fmt.Sprintf("d%d", d.ID), Dept: dept, Text: d.Text, Why: d.Why, CreatedAt: d.CreatedAt})
	}
	for _, d := range order {
		if count[d] > org.MaxDecisions {
			over = append(over, fmt.Sprintf("%s %d/%d", d, count[d], org.MaxDecisions))
		}
	}
	return out, skipped, over
}

// skillFiles 解出旧技能的 files JSON（相对路径 → 内容）；必须有 SKILL.md，路径不许越界。
func skillFiles(raw string) (map[string]string, error) {
	var m map[string]string
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, err
	}
	if _, ok := m["SKILL.md"]; !ok {
		return nil, fmt.Errorf("没有 SKILL.md")
	}
	for p := range m {
		if !safeRel(p) {
			return nil, fmt.Errorf("附属文件路径 %q 不安全", p)
		}
	}
	return m, nil
}

// checkHostJSON：机器信息与仓库清单要是 hosts 包读得懂的 JSON（信息是对象、仓库是文字数组）。
func checkHostJSON(info, repos string) error {
	if info != "" {
		var m map[string]any
		if err := json.Unmarshal([]byte(info), &m); err != nil {
			return fmt.Errorf("info 不是 JSON 对象：%w", err)
		}
	}
	var list []string
	if err := json.Unmarshal([]byte(repos), &list); err != nil {
		return fmt.Errorf("repos 不是文字数组：%w", err)
	}
	return nil
}

// safeRel 判定清单里的相对路径可以落盘：不许绝对路径、..、隐藏段。
func safeRel(p string) bool {
	if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, "\\") {
		return false
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." || strings.HasPrefix(seg, ".") {
			return false
		}
	}
	return true
}
