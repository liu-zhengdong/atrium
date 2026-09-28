// Package pause 是一键停机的状态与判定：全局（all）、按部门（oN，含下属）、按机器（hN）。
// 派活、唤醒、周期任务、合入、发版在每次自主动作前调 Paused；命令在 service 包（pause/resume）。
package pause

import (
	"context"
	"slices"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// All 是全局暂停的范围名。
const All = "all"

// Scope 描述一次自主动作碰到的范围：部门链（该部门及全部上级，顺序不限）与机器。
type Scope struct {
	Orgs []string
	Host string
}

// Paused 纯判定：active 是当前所有暂停范围。全局、链上任一部门、所在机器任一暂停即为暂停。
func Paused(active []string, s Scope) bool {
	for _, a := range active {
		if a == All || (s.Host != "" && a == s.Host) || slices.Contains(s.Orgs, a) {
			return true
		}
	}
	return false
}

// ValidScope 校验范围名：all、oN 或 hN。
func ValidScope(scope string) error {
	if scope == All || api.IsRef(scope, "o") || api.IsRef(scope, "h") {
		return nil
	}
	return api.Usage("暂停范围应为 all、部门 oN 或机器 hN，收到 %q", scope)
}

type Entry struct {
	Scope string `json:"scope"`
	By    string `json:"by"`
	At    int64  `json:"at"`
}

type Store struct{ DB *store.DB }

// Set 记一个暂停范围（已暂停则不变）。
func (p *Store) Set(ctx context.Context, scope, by string) error {
	if err := ValidScope(scope); err != nil {
		return err
	}
	_, err := p.DB.ExecContext(ctx,
		`INSERT INTO pauses (scope, by, at) VALUES (?, ?, ?) ON CONFLICT (scope) DO NOTHING`,
		scope, by, store.Now())
	return err
}

// Clear 撤一个暂停范围；返回它原先是否在暂停。
func (p *Store) Clear(ctx context.Context, scope string) (bool, error) {
	if err := ValidScope(scope); err != nil {
		return false, err
	}
	res, err := p.DB.ExecContext(ctx, `DELETE FROM pauses WHERE scope = ?`, scope)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (p *Store) List(ctx context.Context) ([]Entry, error) {
	return list(ctx, p.DB)
}

func list(ctx context.Context, q store.Querier) ([]Entry, error) {
	rows, err := q.QueryContext(ctx, `SELECT scope, by, at FROM pauses ORDER BY at, scope LIMIT 1000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.Scope, &e.By, &e.At); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// Active 读当前全部暂停范围（给只读视图：网页「今天」标暂停）。
func Active(ctx context.Context, q store.Querier) ([]string, error) {
	entries, err := list(ctx, q)
	if err != nil {
		return nil, err
	}
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Scope
	}
	return out, nil
}

// Paused 读当前暂停范围并判定。部门链由调用方给（org.Ancestors）。
func (p *Store) Paused(ctx context.Context, s Scope) (bool, error) {
	entries, err := list(ctx, p.DB)
	if err != nil {
		return false, err
	}
	active := make([]string, len(entries))
	for i, e := range entries {
		active[i] = e.Scope
	}
	return Paused(active, s), nil
}
