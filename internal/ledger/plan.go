package ledger

import (
	"fmt"
	"sort"
	"strings"
)

// Priority：紧急、修复、普通、闲时。派活队列按 Rank 从小到大取。
type Priority string

const (
	Urgent Priority = "urgent"
	Fix    Priority = "fix"
	Normal Priority = "normal"
	Idle   Priority = "idle"
)

var priorities = []Priority{Urgent, Fix, Normal, Idle}

// Rank 是队列排序用的数；非法优先级返回 -1。
func (p Priority) Rank() int {
	for i, v := range priorities {
		if p == v {
			return i
		}
	}
	return -1
}

// DepState 是一个依赖的短号与状态。
type DepState struct {
	ID     string `json:"id"`
	Status Status `json:"status"`
}

// DepGate 判定一件任务的依赖：失败或取消的是 broken（等不到了）；别的没完成的是 waiting（还在等）；两个都空才算依赖齐了。
// 派活队列、task run、任务树、task show、持球判定、网页共用这一份。
func DepGate(deps []DepState) (waiting []string, broken []DepState) {
	for _, d := range deps {
		switch d.Status {
		case Done:
		case Failed, Cancelled:
			broken = append(broken, d)
		default:
			waiting = append(waiting, d.ID)
		}
	}
	return waiting, broken
}

// BrokenText 是断掉的依赖的人话：「t449 已取消」「t449 已取消、t450 失败了」。
func BrokenText(broken []DepState) string {
	parts := make([]string, len(broken))
	for i, d := range broken {
		label := "失败了"
		if d.Status == Cancelled {
			label = "已取消"
		}
		parts[i] = d.ID + " " + label
	}
	return strings.Join(parts, "、")
}

// Summary 是一组任务（通常是某任务的全部子孙）的状态计数。
type Summary struct {
	Total  int            `json:"total"`
	Counts map[Status]int `json:"counts"`
}

// Open 是还没结束的件数（完成、失败、取消之外）。
func (s Summary) Open() int {
	return s.Total - s.Counts[Done] - s.Counts[Failed] - s.Counts[Cancelled]
}

func Summarize(statuses []Status) Summary {
	s := Summary{Total: len(statuses), Counts: map[Status]int{}}
	for _, st := range statuses {
		s.Counts[st]++
	}
	return s
}

// Rollup 把一组子任务汇成一个总状态：全部结束（完成或取消）→ done；有在派或在跑 → running；
// 有失败或受阻 → blocked；其余（含草稿）→ todo。没有子任务返回空串。
func (s Summary) Rollup() Status {
	c := s.Counts
	switch {
	case s.Total == 0:
		return ""
	case c[Done]+c[Cancelled] == s.Total:
		return Done
	case c[Running]+c[Queued] > 0:
		return Running
	case c[Failed]+c[Blocked] > 0:
		return Blocked
	}
	return Todo
}

// String 给人看：「3/5 完成，1 在做，1 受阻」。
func (s Summary) String() string {
	if s.Total == 0 {
		return ""
	}
	out := fmt.Sprintf("%d/%d 完成", s.Counts[Done], s.Total)
	for _, p := range []struct {
		n     int
		label string
	}{
		{s.Counts[Running] + s.Counts[Queued], "在做"},
		{s.Counts[Blocked], "受阻"},
		{s.Counts[Failed], "失败"},
		{s.Counts[Cancelled], "取消"},
		{s.Counts[Draft], "草稿"},
	} {
		if p.n > 0 {
			out += fmt.Sprintf("，%d %s", p.n, p.label)
		}
	}
	return out
}

// FindCycle 在依赖边（任务 → 它依赖的任务）里找环，返回环上的任务（首尾相同）；没有环返回 nil。
func FindCycle(edges map[string][]string) []string {
	const (
		white = iota
		grey
		black
	)
	color := map[string]int{}
	var stack []string
	var visit func(n string) []string
	visit = func(n string) []string {
		color[n] = grey
		stack = append(stack, n)
		for _, m := range edges[n] {
			switch color[m] {
			case grey:
				for i, s := range stack {
					if s == m {
						return append(append([]string{}, stack[i:]...), m)
					}
				}
			case white:
				if c := visit(m); c != nil {
					return c
				}
			}
		}
		stack = stack[:len(stack)-1]
		color[n] = black
		return nil
	}
	keys := make([]string, 0, len(edges))
	for k := range edges {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if color[k] == white {
			if c := visit(k); c != nil {
				return c
			}
		}
	}
	return nil
}
