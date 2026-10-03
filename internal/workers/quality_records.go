package workers

import (
	"context"
	"sort"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// ReadQuality 分页读取全部相关经历，每件任务仍由 Settle 判定，不截断历史。
func ReadQuality(ctx context.Context, db store.Querier) ([]Quality, error) {
	byTask := map[string][]Event{}
	var upper int64
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(MAX(id), 0) FROM task_events`).Scan(&upper); err != nil {
		return nil, err
	}
	var cursor int64
	for {
		rows, err := db.QueryContext(ctx, `SELECT id, task, kind, body, at FROM task_events WHERE id > ? AND id <= ? AND kind IN (?, ?, 'exit_ok', 'exit_fail', 'bounce') ORDER BY id LIMIT 1000`, cursor, upper, RunKind, ExitKind)
		if err != nil {
			return nil, err
		}
		n := 0
		for rows.Next() {
			var task string
			var e Event
			if err := rows.Scan(&cursor, &task, &e.Kind, &e.Body, &e.At); err != nil {
				rows.Close()
				return nil, err
			}
			byTask[task] = append(byTask[task], e)
			n++
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		if n < 1000 {
			break
		}
	}
	var all []Attempt
	ids := make([]string, 0, len(byTask))
	for id := range byTask {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		ls, err := Settle(id, byTask[id])
		if err != nil {
			return nil, err
		}
		all = append(all, ls...)
	}
	return Qualities(all), nil
}
