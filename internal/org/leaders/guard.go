package leaders

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strconv"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// guard 是负责人令牌的统一权限判定（路由匹配、认证之后，处理函数之前）：按 RuleFor 取规则，只查事实，判定在 model.go。
func guard(db *store.DB) api.Guard {
	return func(q *api.Req) error {
		leader := q.Actor.ID
		for _, k := range []string{"as", "target"} {
			if v := q.URL.Query().Get(k); v != "" && v != leader {
				return Forbid("负责人只能以自己的身份（%s）读写，收到 %s=%s", leader, k, v)
			}
		}
		rule := RuleFor(q.Pattern)
		switch rule {
		case RuleDeny:
			return Forbid("负责人不能调 %s", q.Pattern)
		case RuleRead, RuleMemo, RuleEscalate:
			return nil // 备忘与上交由处理函数按身份判
		}
		body, err := peekBody(q)
		if err != nil {
			return err
		}
		ctx := q.Context()
		if rule == RuleEventsAck {
			return ackCheck(ctx, db, leader, q, body)
		}
		checks, err := collect(ctx, db, rule, q, body)
		if err != nil {
			return err
		}
		ps, err := org.Parents(ctx, db)
		if err != nil {
			return err
		}
		lm, err := org.LeaderMap(ctx, db)
		if err != nil {
			return err
		}
		return InScope(leader, org.Scope(ps, lm, leader), checks)
	}
}

// peekBody 读出请求体（上限 1MB）再放回去，处理函数照常 Decode。
func peekBody(q *api.Req) (map[string]any, error) {
	if q.Body == nil {
		return map[string]any{}, nil
	}
	raw, err := io.ReadAll(io.LimitReader(q.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	q.Body = io.NopCloser(bytes.NewReader(raw))
	m := map[string]any{}
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, api.Usage("请求体不合法：%v", err)
		}
	}
	return m, nil
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

// collect 按规则取出这次请求碰到的东西各属于哪个部门。
func collect(ctx context.Context, db *store.DB, rule Rule, q *api.Req, body map[string]any) ([]Check, error) {
	var checks []Check
	id := q.PathValue("id")
	taskDept := func(what, ref string) error {
		t, err := ledger.Get(ctx, db, ref)
		if err != nil {
			return err
		}
		checks = append(checks, Check{What: what + " " + t.ID, Dept: t.Org})
		return nil
	}
	lookup := func(what, table string) error {
		var dept string
		err := db.QueryRowContext(ctx, `SELECT department FROM `+table+` WHERE id = ? LIMIT 1`, id).Scan(&dept)
		if store.IsNotFound(err) {
			return api.NotFound("%s %s 不存在", what, id)
		}
		if err != nil {
			return err
		}
		checks = append(checks, Check{What: what + " " + id, Dept: dept})
		return nil
	}
	bodyDept := func() {
		for _, k := range []string{"org", "department"} {
			if v := str(body, k); v != "" {
				checks = append(checks, Check{What: "部门", Dept: v})
			}
		}
	}
	var err error
	switch rule {
	case RuleTaskRef:
		err = taskDept("任务", id)
		bodyDept()
	case RuleTaskCreate:
		bodyDept()
		if p := str(body, "parent"); p != "" {
			err = taskDept("父任务", p)
		}
		if len(checks) == 0 {
			return nil, Forbid("负责人建任务要写归属部门（--org oN）或父任务")
		}
	case RuleDeptRef:
		checks = append(checks, Check{What: "部门", Dept: id})
	case RulePointRef:
		err = lookup("要点", "points")
	case RuleMaterialRef:
		err = lookup("资料", "materials")
	case RuleScheduleRef:
		err = lookup("周期任务", "schedules")
	case RuleBodyDept:
		bodyDept()
		if len(checks) == 0 {
			return nil, Forbid("负责人建这类东西要写归属部门（oN）")
		}
	}
	return checks, err
}

// ackCheck：只能确认投给自己的事件。事件编号取路径 {id} 与请求体的 ids／id。
func ackCheck(ctx context.Context, db *store.DB, leader string, q *api.Req, body map[string]any) error {
	var ids []int64
	add := func(v any) {
		switch x := v.(type) {
		case float64:
			ids = append(ids, int64(x))
		case string:
			if n, err := strconv.ParseInt(x, 10, 64); err == nil {
				ids = append(ids, n)
			}
		}
	}
	add(q.PathValue("id"))
	add(body["id"])
	if list, ok := body["ids"].([]any); ok {
		for _, v := range list {
			add(v)
		}
	}
	if len(ids) == 0 {
		return Forbid("没认出要确认的事件编号")
	}
	for _, id := range ids {
		var target string
		err := db.QueryRowContext(ctx, `SELECT target FROM events WHERE id = ?`, id).Scan(&target)
		if store.IsNotFound(err) {
			return api.NotFound("事件 #%d 不存在", id)
		}
		if err != nil {
			return err
		}
		if target != leader {
			return Forbid("事件 #%d 投给 %s，不是你（%s）", id, target, leader)
		}
	}
	return nil
}
