package ledger

import (
	"strconv"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
)

// Module 是账本的接入点。
func Module() app.Module {
	return app.Module{Name: "ledger", Commands: Commands, Routes: Routes}
}

// TreeNode 是任务树的一个节点；Summary 汇总全部子孙。
type TreeNode struct {
	Task
	Summary  *Summary    `json:"summary,omitempty"`
	Children []*TreeNode `json:"children,omitempty"`
}

// BuildTree 把 Subtree 的结果（root 在第一个，父先于子）搭成树。纯函数。
func BuildTree(tasks []Task) *TreeNode {
	nodes := map[string]*TreeNode{}
	var root *TreeNode
	for i, t := range tasks {
		n := &TreeNode{Task: t}
		nodes[t.ID] = n
		if i == 0 {
			root = n
		} else if p := nodes[t.Parent]; p != nil {
			p.Children = append(p.Children, n)
		}
	}
	var fill func(n *TreeNode) []Status
	fill = func(n *TreeNode) []Status {
		var all []Status
		for _, c := range n.Children {
			all = append(all, c.Status)
			all = append(all, fill(c)...)
		}
		if len(all) > 0 {
			s := Summarize(all)
			n.Summary = &s
		}
		return all
	}
	if root != nil {
		fill(root)
	}
	return root
}

// Detail 是 task show 的内容。
type Detail struct {
	Task      Task        `json:"task"`
	Parties   Parties     `json:"parties"`
	Deps      []DepState  `json:"deps"`
	Ready     bool        `json:"ready"`
	WaitingOn []string    `json:"waiting_on,omitempty"`
	Children  *Summary    `json:"children,omitempty"`
	History   []TaskEvent `json:"history"`
}

// SetBody 是 PATCH /api/tasks/{id}：描述字段与状态可同时改。
type SetBody struct {
	Patch
	Status *Status `json:"status,omitempty"`
	Note   string  `json:"note,omitempty"`
}

// WaitResult 是 task wait 的结果；Reached 为假表示等到超时。
type WaitResult struct {
	Task    Task `json:"task"`
	Reached bool `json:"reached"`
}

// DefaultUntil：task wait 缺省等到这些状态之一（需要有人看的状态）。
var DefaultUntil = []Status{Done, Failed, Blocked, Cancelled}

const maxWait = time.Hour

func Routes(r *api.Router, env *app.Env) {
	db := env.DB
	r.Handle("POST /api/tasks", func(q *api.Req) (any, error) {
		var in NewTask
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return Add(q.Context(), db, in, q.Actor.ID)
	})
	r.Handle("GET /api/tasks", func(q *api.Req) (any, error) {
		f := Filter{Org: q.URL.Query().Get("org"), Parent: q.URL.Query().Get("parent"), Top: q.URL.Query().Get("top") == "1"}
		for _, s := range splitList(q.URL.Query().Get("status")) {
			if !Status(s).Valid() {
				return nil, api.Usage("--status: 未知状态 %q", s)
			}
			f.Status = append(f.Status, Status(s))
		}
		if v := q.URL.Query().Get("limit"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				return nil, api.Usage("--limit: 应为整数")
			}
			f.Limit = n
		}
		return List(q.Context(), db, f)
	})
	r.Handle("GET /api/tasks/{id}", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "t")
		if err != nil {
			return nil, err
		}
		t, err := Get(q.Context(), db, id)
		if err != nil {
			return nil, err
		}
		d := Detail{Task: t}
		if d.Parties, err = PartiesOf(q.Context(), db, id); err != nil {
			return nil, err
		}
		if d.Deps, err = Deps(q.Context(), db, id); err != nil {
			return nil, err
		}
		d.Ready, d.WaitingOn = Ready(t.Status, d.Deps)
		sub, err := Subtree(q.Context(), db, id)
		if err != nil {
			return nil, err
		}
		d.Children = BuildTree(sub).Summary
		d.History, err = History(q.Context(), db, id, 20)
		return d, err
	})
	r.Handle("PATCH /api/tasks/{id}", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "t")
		if err != nil {
			return nil, err
		}
		var in SetBody
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		if in.Patch.empty() && in.Status == nil {
			return nil, api.Usage("没有要改的字段").WithNext("atrium task set --help")
		}
		var t Task
		if !in.Patch.empty() {
			if t, err = Edit(q.Context(), db, id, in.Patch, q.Actor.ID); err != nil {
				return nil, err
			}
		}
		if in.Status != nil {
			ev := Event{Kind: Set, To: *in.Status}
			if *in.Status == Cancelled {
				ev = Event{Kind: Cancel}
			}
			if t, err = Apply(q.Context(), db, id, ev, q.Actor.ID, in.Note); err != nil {
				return nil, err
			}
		}
		return t, nil
	})
	r.Handle("GET /api/tree", func(q *api.Req) (any, error) {
		roots, err := List(q.Context(), db, Filter{Top: true, Limit: 50})
		if err != nil {
			return nil, err
		}
		out := []*TreeNode{}
		for _, t := range roots {
			sub, err := Subtree(q.Context(), db, t.ID)
			if err != nil {
				return nil, err
			}
			out = append(out, BuildTree(sub))
		}
		return out, nil
	})
	r.Handle("GET /api/tasks/{id}/tree", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "t")
		if err != nil {
			return nil, err
		}
		sub, err := Subtree(q.Context(), db, id)
		if err != nil {
			return nil, err
		}
		return []*TreeNode{BuildTree(sub)}, nil
	})
	r.Handle("GET /api/tasks/{id}/plan", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "t")
		if err != nil {
			return nil, err
		}
		sub, err := Subtree(q.Context(), db, id)
		if err != nil {
			return nil, err
		}
		if len(sub) > 1 {
			sub = sub[1:] // 有子任务时排子孙；没有时排它自己
		}
		ids := make([]string, len(sub))
		for i, t := range sub {
			ids[i] = t.ID
		}
		edges, outside, err := DepsOf(q.Context(), db, ids)
		if err != nil {
			return nil, err
		}
		in := make([]PlanInput, len(sub))
		for i, t := range sub {
			in[i] = PlanInput{ID: t.ID, Title: t.Title, Status: t.Status, Deps: edges[t.ID]}
		}
		return Plan(in, outside), nil
	})
	r.Handle("POST /api/tasks/{id}/notes", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "t")
		if err != nil {
			return nil, err
		}
		var in struct {
			Text string `json:"text"`
		}
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return map[string]string{"task": id}, Note(q.Context(), db, id, q.Actor.ID, in.Text)
	})
	r.Handle("GET /api/tasks/{id}/wait", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "t")
		if err != nil {
			return nil, err
		}
		until, orAccept := DefaultUntil, true // 缺省等法也停在等验收：那时要有人判
		if v := q.URL.Query().Get("until"); v != "" {
			orAccept = false
			until = nil
			for _, s := range splitList(v) {
				if !Status(s).Valid() {
					return nil, api.Usage("--until: 未知状态 %q", s)
				}
				until = append(until, Status(s))
			}
		}
		timeout := 10 * time.Minute
		if v := q.URL.Query().Get("timeout"); v != "" {
			sec, err := strconv.Atoi(v)
			if err != nil || sec < 0 || time.Duration(sec)*time.Second > maxWait {
				return nil, api.Usage("--timeout: 应为 0–3600 的秒数")
			}
			timeout = time.Duration(sec) * time.Second
		}
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		for {
			wake := Changed()
			t, err := Get(q.Context(), db, id)
			if err != nil {
				return nil, err
			}
			if orAccept && t.Status == Running && t.Stage == StageAccept {
				return WaitResult{Task: t, Reached: true}, nil
			}
			for _, s := range until {
				if t.Status == s {
					return WaitResult{Task: t, Reached: true}, nil
				}
			}
			select {
			case <-wake:
			case <-timer.C:
				return WaitResult{Task: t}, nil
			case <-q.Context().Done():
				return nil, q.Context().Err()
			}
		}
	})
}

func splitList(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
