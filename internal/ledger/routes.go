package ledger

import (
	"strconv"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Module 是账本的接入点。
func Module() app.Module {
	return app.Module{Name: "ledger", Commands: Commands, Routes: Routes, Run: cleanupStoredLogs}
}

// TreeNode 是任务树的一个节点；Summary 汇总全部子孙。Ready：没有子任务、自己 todo、依赖都完成，现在能派；
// WaitingOn、Broken：todo 或排队中的任务还在等的依赖、失败或取消了等不到的依赖（见 DepGate）。
type TreeNode struct {
	Task
	Summary   *Summary    `json:"summary,omitempty"`
	Ready     bool        `json:"ready,omitempty"`
	WaitingOn []string    `json:"waiting_on,omitempty"`
	Broken    []DepState  `json:"broken,omitempty"`
	Children  []*TreeNode `json:"children,omitempty"`
}

// BuildTree 把 Subtree 的结果（root 在第一个，父先于子）与 SubtreeDeps 的依赖搭成树。纯函数。
func BuildTree(tasks []Task, deps map[string][]DepState) *TreeNode {
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
		waiting, broken := DepGate(deps[n.ID])
		n.Ready = n.Status == Todo && len(waiting)+len(broken) == 0 && len(n.Children) == 0 // 有子任务的由子任务汇总，不派它自己
		if n.Status == Todo || n.Status == Queued {
			n.WaitingOn, n.Broken = waiting, broken
		}
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
	Task          Task        `json:"task"`
	Parties       Parties     `json:"parties"`
	ByName        string      `json:"by_name,omitempty"` // 任务分派人的名字，只给带来源的（来源一行写「组织发现 · 名字」）
	Deps          []DepState  `json:"deps"`
	Ready         bool        `json:"ready"`
	WaitingOn     []string    `json:"waiting_on,omitempty"`
	Broken        []DepState  `json:"broken,omitempty"`
	Children      *Summary    `json:"children,omitempty"`
	History       []TaskEvent `json:"history"`
	HistoryBefore int64       `json:"history_before,omitempty"`
	HistoryTotal  int         `json:"history_total"`
	Acceptance    *Acceptance `json:"acceptance,omitempty"`
}

// SetBody 是 PATCH /api/tasks/{id}：描述字段与状态可同时改。
type SetBody struct {
	Patch
	Status *Status `json:"status,omitempty"`
	Note   string  `json:"note,omitempty"`
	Accept *string `json:"accept,omitempty"`
}

// WaitResult 是 task wait 的结果；Reached 为假表示等到超时。
type WaitResult struct {
	Task    Task `json:"task"`
	Reached bool `json:"reached"`
}

// DefaultUntil：task wait 缺省等到这些状态之一（需要有人看的状态）。
var DefaultUntil = []Status{Done, Failed, Blocked, Cancelled}

const maxWait = time.Hour

// tree 读出 id 这棵任务树，带汇总与每件的能派／在等谁。
func tree(q *api.Req, db store.Querier, id string) (*TreeNode, error) {
	sub, err := Subtree(q.Context(), db, id)
	if err != nil {
		return nil, err
	}
	deps, err := SubtreeDeps(q.Context(), db, id)
	if err != nil {
		return nil, err
	}
	return BuildTree(sub, deps), nil
}

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
		if d.Acceptance, err = AcceptanceOf(q.Context(), db, id); err != nil {
			return nil, err
		}
		if d.Parties, err = PartiesOf(q.Context(), db, id); err != nil {
			return nil, err
		}
		if t.Source != "" && d.Parties.By != "" {
			if d.ByName, err = org.NameOf(q.Context(), db, d.Parties.By); err != nil {
				return nil, err
			}
		}
		if d.Deps, err = Deps(q.Context(), db, id); err != nil {
			return nil, err
		}
		d.WaitingOn, d.Broken = DepGate(d.Deps)
		d.Ready = t.Status == Todo && len(d.WaitingOn)+len(d.Broken) == 0
		sub, err := Subtree(q.Context(), db, id)
		if err != nil {
			return nil, err
		}
		d.Children = BuildTree(sub, nil).Summary
		limit, before, err := historyWindow(q.URL.Query().Get("history_limit"), q.URL.Query().Get("before"))
		if err != nil {
			return nil, err
		}
		d.History, err = HistoryBefore(q.Context(), db, id, limit+1, before)
		if err != nil {
			return nil, err
		}
		if len(d.History) > limit {
			d.History = d.History[1:]
			d.HistoryBefore = d.History[0].ID
		}
		err = db.QueryRowContext(q.Context(), "SELECT count(*) FROM task_events WHERE task = ?", id).Scan(&d.HistoryTotal)
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
		if in.Patch.empty() && in.Status == nil && in.Accept == nil {
			return nil, api.Usage("没有要改的字段").WithNext("atrium task set --help")
		}
		var t Task
		if in.Accept != nil {
			if !in.Patch.empty() || in.Status != nil {
				return nil, api.Usage("--accept: 单独操作任务决定")
			}
			return Decide(q.Context(), db, id, *in.Accept, in.Note, q.Actor.ID)
		}
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
	r.Handle("GET /api/task-parties", func(q *api.Req) (any, error) {
		ids, err := partyIDs(q.URL.Query().Get("ids"))
		if err != nil {
			return nil, err
		}
		return readParties(q.Context(), db, ids)
	})
	r.Handle("GET /api/classes", func(q *api.Req) (any, error) { return Classes(q.Context(), db) })
	r.Handle("GET /api/tree", func(q *api.Req) (any, error) {
		roots, err := List(q.Context(), db, Filter{Top: true, Limit: 50})
		if err != nil {
			return nil, err
		}
		out := []*TreeNode{}
		for _, t := range roots {
			n, err := tree(q, db, t.ID)
			if err != nil {
				return nil, err
			}
			out = append(out, n)
		}
		return out, nil
	})
	r.Handle("GET /api/tasks/{id}/tree", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "t")
		if err != nil {
			return nil, err
		}
		n, err := tree(q, db, id)
		if err != nil {
			return nil, err
		}
		return []*TreeNode{n}, nil
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
