package ledger

import (
	"fmt"
	"sort"
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

// Ready 判定一件任务能否派：自己是 todo，且全部依赖已完成。waiting 是还没完成的依赖。
func Ready(s Status, deps []DepState) (ready bool, waiting []string) {
	for _, d := range deps {
		if d.Status != Done {
			waiting = append(waiting, d.ID)
		}
	}
	return s == Todo && len(waiting) == 0, waiting
}

// Summary 是一组任务（通常是某任务的全部子孙）的状态计数。
type Summary struct {
	Total  int            `json:"total"`
	Counts map[Status]int `json:"counts"`
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

// PlanInput 是计划里的一件任务。
type PlanInput struct {
	ID     string
	Title  string
	Status Status
	Deps   []string
}

// PlanRow：Step 是按依赖分层的第几步（1 起；已结束的任务为 0）；State 是 done/ready/waiting/running……
type PlanRow struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Status    Status   `json:"status"`
	Step      int      `json:"step"`
	Ready     bool     `json:"ready"`
	WaitingOn []string `json:"waiting_on,omitempty"`
}

// Plan 给一组任务排出先后：依赖都完成且自己 todo 的可以派（Ready）；其余按依赖深度分步。
// 集合外的依赖视为未满足且不参与分步（它们挂在别处）。结果按 Step、再按输入顺序排。
func Plan(tasks []PlanInput, outside map[string]Status) []PlanRow {
	byID := map[string]PlanInput{}
	order := map[string]int{}
	for i, t := range tasks {
		byID[t.ID], order[t.ID] = t, i
	}
	step := map[string]int{}
	var depth func(id string, seen map[string]bool) int
	depth = func(id string, seen map[string]bool) int {
		if v, ok := step[id]; ok {
			return v
		}
		t := byID[id]
		if t.Status.Finished() {
			step[id] = 0
			return 0
		}
		if seen[id] {
			return 1 // 有环时不无限递归；环由写入时的 FindCycle 拒绝，这里只防御读
		}
		seen[id] = true
		d := 1
		for _, dep := range t.Deps {
			if _, in := byID[dep]; in {
				d = max(d, depth(dep, seen)+1)
			}
		}
		step[id] = d
		return d
	}
	rows := make([]PlanRow, 0, len(tasks))
	for _, t := range tasks {
		deps := make([]DepState, 0, len(t.Deps))
		for _, d := range t.Deps {
			st, in := outside[d]
			if dt, ok := byID[d]; ok {
				st, in = dt.Status, true
			}
			if !in {
				st = ""
			}
			deps = append(deps, DepState{ID: d, Status: st})
		}
		ready, waiting := Ready(t.Status, deps)
		rows = append(rows, PlanRow{ID: t.ID, Title: t.Title, Status: t.Status,
			Step: depth(t.ID, map[string]bool{}), Ready: ready, WaitingOn: waiting})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].Step != rows[j].Step {
			return rows[i].Step < rows[j].Step
		}
		return order[rows[i].ID] < order[rows[j].ID]
	})
	return rows
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
