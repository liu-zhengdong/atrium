package ledger

import (
	"context"
	"github.com/liu-zhengdong/atrium/internal/store"
)

type TaskEvent struct {
	ID    int64  `json:"id"`
	At    int64  `json:"at"`
	Kind  string `json:"kind"`
	Actor string `json:"actor"`
	Body  string `json:"body,omitempty"`
}

// History 取最近 limit 条经历（按时间正序）。
func History(ctx context.Context, q store.Querier, id string, limit int) ([]TaskEvent, error) {
	return HistoryBefore(ctx, q, id, limit, 0)
}

// HistoryBefore 返回游标之前最近的一页，页内正序；游标为0从最新页起。
func HistoryBefore(ctx context.Context, q store.Querier, id string, limit int, before int64) ([]TaskEvent, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, at, kind, actor, body FROM
 (SELECT * FROM task_events WHERE task = ? AND (? = 0 OR id < ?) ORDER BY id DESC LIMIT ?) ORDER BY id`, id, before, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TaskEvent{}
	for rows.Next() {
		var e TaskEvent
		if err := rows.Scan(&e.ID, &e.At, &e.Kind, &e.Actor, &e.Body); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
