package org

import (
	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// LeaderShow 是 leader ls aN 的内容：身份与备忘。
type LeaderShow struct {
	Identity
	Memo Memo `json:"memo"`
}

type memoBody struct {
	Body string `json:"body"`
}

func userOnly(q *api.Req) error {
	if q.Actor.Kind != "user" {
		return api.Forbidden("只有用户能登记或改负责人")
	}
	return nil
}

func identityRoutes(r *api.Router, db *store.DB) {
	r.Handle("GET /api/leaders", func(q *api.Req) (any, error) { return Leaders(q.Context(), db) })
	r.Handle("POST /api/leaders", func(q *api.Req) (any, error) {
		if err := userOnly(q); err != nil {
			return nil, err
		}
		var in NewLeader
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return AddLeader(q.Context(), db, in)
	})
	r.Handle("GET /api/leaders/{id}", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "a")
		if err != nil {
			return nil, err
		}
		i, err := GetIdentity(q.Context(), db, id)
		if err != nil {
			return nil, err
		}
		m, err := GetMemo(q.Context(), db, id)
		return LeaderShow{Identity: i, Memo: m}, err
	})
	r.Handle("PATCH /api/leaders/{id}", func(q *api.Req) (any, error) {
		if err := userOnly(q); err != nil {
			return nil, err
		}
		id, err := q.Ref("id", "a")
		if err != nil {
			return nil, err
		}
		var p LeaderPatch
		if err := q.Decode(&p); err != nil {
			return nil, err
		}
		return EditLeader(q.Context(), db, id, p)
	})
	r.Handle("GET /api/memo", func(q *api.Req) (any, error) {
		owner, err := MemoOwner(q.Actor, q.URL.Query().Get("as"))
		if err != nil {
			return nil, err
		}
		return GetMemo(q.Context(), db, owner)
	})
	r.Handle("PUT /api/memo", func(q *api.Req) (any, error) {
		owner, err := MemoOwner(q.Actor, q.URL.Query().Get("as"))
		if err != nil {
			return nil, err
		}
		var b memoBody
		if err := q.Decode(&b); err != nil {
			return nil, err
		}
		return SetMemo(q.Context(), db, owner, b.Body, q.Actor.ID)
	})
}
