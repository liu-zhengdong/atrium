package org

import (
	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
)

func Module() app.Module {
	return app.Module{Name: "org", Commands: Commands, Routes: Routes}
}

// Show 是 org show 的内容：部门本身、直接下属、自己的要点与从上级继承来的要点。
type Show struct {
	Dept      Dept     `json:"dept"`
	Path      []string `json:"path"`
	Children  []*Node  `json:"children"`
	Points    []Point  `json:"points"`
	Inherited []Point  `json:"inherited"`
	Room      int      `json:"room"` // 还能加几条要点
	Limits    []Count  `json:"limits"`
	// Accept 是验收人（沿树继承）；AcceptFrom 是设它的部门，没设过（缺省 auto）为空。
	Accept     string `json:"accept"`
	AcceptFrom string `json:"accept_from,omitempty"`
	// Leader 是管这个部门的负责人（和事件投递同一个判定，Nearest），整棵树都没有为秘书；
	// LeaderFrom 是登记它的部门（秘书时为空）。
	Leader     string `json:"leader"`
	LeaderFrom string `json:"leader_from,omitempty"`
}

func Routes(r *api.Router, env *app.Env) {
	db := env.DB
	resourceRoutes(r, env)
	r.Handle("GET /api/org", func(q *api.Req) (any, error) { return Tree(q.Context(), db) })
	r.Handle("POST /api/org", func(q *api.Req) (any, error) {
		var in NewDept
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return Add(q.Context(), db, in)
	})
	r.Handle("GET /api/org/{id}", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "o")
		if err != nil {
			return nil, err
		}
		d, err := Get(q.Context(), db, id)
		if err != nil {
			return nil, err
		}
		s := Show{Dept: d, Children: []*Node{}}
		if s.Path, err = Ancestors(q.Context(), db, id); err != nil {
			return nil, err
		}
		if s.Accept, s.AcceptFrom, err = Acceptor(q.Context(), db, id); err != nil {
			return nil, err
		}
		ps, err := parents(q.Context(), db)
		if err != nil {
			return nil, err
		}
		lm, err := LeaderMap(q.Context(), db)
		if err != nil {
			return nil, err
		}
		s.Leader, s.LeaderFrom = Nearest(ps, lm, id, "")
		chain, err := Chain(q.Context(), db, id)
		if err != nil {
			return nil, err
		}
		s.Points, s.Inherited = []Point{}, []Point{}
		for _, p := range chain {
			if p.Org == id {
				s.Points = append(s.Points, p)
			} else {
				s.Inherited = append(s.Inherited, p)
			}
		}
		s.Room = max(MaxPoints-len(s.Points), 0) // 超限时为 0（Points 照样全给）
		if s.Limits, err = Counts(q.Context(), db, id); err != nil {
			return nil, err
		}
		forest, err := Tree(q.Context(), db)
		if err != nil {
			return nil, err
		}
		if n := find(forest, id); n != nil {
			for _, c := range n.Children {
				s.Children = append(s.Children, &Node{Dept: c.Dept, Points: c.Points})
			}
		}
		return s, nil
	})
	r.Handle("PATCH /api/org/{id}", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "o")
		if err != nil {
			return nil, err
		}
		var p DeptPatch
		if err := q.Decode(&p); err != nil {
			return nil, err
		}
		return Edit(q.Context(), db, id, p)
	})
	r.Handle("POST /api/org/{id}/points", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "o")
		if err != nil {
			return nil, err
		}
		var in NewPoint
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return AddPoint(q.Context(), db, id, in, q.Actor.ID)
	})
	r.Handle("PATCH /api/points/{id}", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "k")
		if err != nil {
			return nil, err
		}
		var p PointPatch
		if err := q.Decode(&p); err != nil {
			return nil, err
		}
		return EditPoint(q.Context(), db, id, p, q.Actor.ID)
	})
	identityRoutes(r, db)
}

func find(nodes []*Node, id string) *Node {
	for _, n := range nodes {
		if n.ID == id {
			return n
		}
		if f := find(n.Children, id); f != nil {
			return f
		}
	}
	return nil
}
