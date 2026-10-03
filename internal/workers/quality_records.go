package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/liu-zhengdong/atrium/internal/org/leaders"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// ReadQuality 分页读取全部相关经历，每件任务仍由 Settle 判定，不截断历史；负责人唤醒记录只取保留期内的，另成行。
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
	ws, err := leaders.ReadWakes(ctx, db, store.Now()-leaders.WakeRetention.Milliseconds())
	if err != nil {
		return nil, err
	}
	wakes := make([]Attempt, 0, len(ws))
	for _, w := range ws {
		a, err := WakeAttempt(w)
		if err != nil {
			return nil, err
		}
		wakes = append(wakes, a)
	}
	return Qualities(all, wakes), nil
}

// WakeAttempt 把一条负责人唤醒记录当成一次拉起（Task 是负责人）。
func WakeAttempt(w leaders.Wake) (Attempt, error) {
	a := Attempt{Task: w.Leader, N: w.N, Worker: w.Profile, Model: w.Model, Outcome: w.Outcome, Reason: w.Reason, At: w.At, DurationMS: w.DurationMS}
	if err := json.Unmarshal([]byte(w.Usage), &a.Usage); err != nil {
		return Attempt{}, fmt.Errorf("负责人 %s 的唤醒记录 %d 用量坏了：%w", w.Leader, w.ID, err)
	}
	return a, nil
}
