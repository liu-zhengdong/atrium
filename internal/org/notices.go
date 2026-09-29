package org

import (
	"context"
	"slices"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// loadNotices 读已经提醒过、还没回到上限以内的项。
func loadNotices(ctx context.Context, q store.Querier) (map[NoticeRef]struct{}, error) {
	rows, err := q.QueryContext(ctx, `SELECT scope, key FROM limit_notices LIMIT ?`, ReadCap+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := map[NoticeRef]struct{}{}
	for rows.Next() {
		var r NoticeRef
		if err := rows.Scan(&r.Scope, &r.Key); err != nil {
			return nil, err
		}
		m[r] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return m, capErr("上限已提醒", len(m))
}

// RecordNotice 记下这一项已经提醒过（与发事件同一事务）。
func RecordNotice(ctx context.Context, q store.Querier, scope, key string, used int) error {
	_, err := q.ExecContext(ctx, `INSERT INTO limit_notices (scope, key, used, at) VALUES (?, ?, ?, ?)
		ON CONFLICT(scope, key) DO UPDATE SET used = excluded.used, at = excluded.at`,
		scope, key, used, store.Now())
	return err
}

// ForgetNotice 用量回到上限以内：清掉已提醒，再超才会再发。
func ForgetNotice(ctx context.Context, q store.Querier, scope, key string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM limit_notices WHERE scope = ? AND key = ?`, scope, key)
	return err
}

// ScanNotices 读各部门与全局的用量（Counts），对照已提醒记录，返回该发的和该清的。
func ScanNotices(ctx context.Context, q store.Querier) (emit []LimitNotice, clear []NoticeRef, err error) {
	already, err := loadNotices(ctx, q)
	if err != nil {
		return nil, nil, err
	}
	ps, err := parents(ctx, q)
	if err != nil {
		return nil, nil, err
	}
	leaders, err := LeaderMap(ctx, q)
	if err != nil {
		return nil, nil, err
	}
	add := func(dept, leader string, counts []Count) {
		e, c := PlanNotices(dept, leader, counts, already)
		emit = append(emit, e...)
		clear = append(clear, c...)
	}
	global, err := Counts(ctx, q, "")
	if err != nil {
		return nil, nil, err
	}
	add("", Secretary, global)
	ids := make([]string, 0, len(ps))
	for id := range ps {
		ids = append(ids, id)
	}
	slices.SortFunc(ids, compareRef)
	for _, id := range ids {
		counts, err := Counts(ctx, q, id)
		if err != nil {
			return nil, nil, err
		}
		add(id, Nearest(ps, leaders, id, ""), counts)
	}
	return emit, clear, nil
}
