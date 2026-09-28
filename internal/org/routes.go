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
		s.Room = MaxPoints - len(s.Points)
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
