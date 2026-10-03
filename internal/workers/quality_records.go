package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/liu-zhengdong/atrium/internal/org/leaders"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// QualityWindow 是质量统计的窗口：任务行与负责人行都只算这段时间内的拉起（负责人唤醒记录物理保留期取同值）。
// 任务经历（task_events）是全系统共用的事件流水，按期删会断交回计数、转告对照等判定，这里只做读侧过滤不删数据；
// 窗口内的相关经历按任务量万条以内封顶，查询不再随历史增长。
const QualityWindow = leaders.WakeRetention

// ReadQuality 分页读取窗口内的相关经历，每件任务仍由 Settle 判定；负责人唤醒记录只取保留期内的，另成行。
// 两行同窗口：工具与模型更替快，更早的不代表现在的质量。
func ReadQuality(ctx context.Context, db store.Querier) ([]Quality, error) {
	since := store.Now() - QualityWindow.Milliseconds()
	byTask := map[string][]Event{}
	var upper int64
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(MAX(id), 0) FROM task_events`).Scan(&upper); err != nil {
		return nil, err
	}
	var cursor int64
	for {
		rows, err := db.QueryContext(ctx, `SELECT id, task, kind, body, at FROM task_events WHERE id > ? AND id <= ? AND at >= ? AND kind IN (?, ?, 'exit_ok', 'exit_fail', 'bounce') ORDER BY id LIMIT 1000`, cursor, upper, since, RunKind, ExitKind)
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
	ws, err := leaders.ReadWakes(ctx, db, since)
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
	keys, err := statKeys(ctx, db, attemptWorkers(append(append([]Attempt(nil), all...), wakes...)))
	if err != nil {
		return nil, err
	}
	return Qualities(all, wakes, statKeyOf(keys)), nil
}

// WakeAttempt 把一条负责人唤醒记录当成一次拉起（Task 是负责人）。
func WakeAttempt(w leaders.Wake) (Attempt, error) {
	a := Attempt{Task: w.Leader, N: w.N, Worker: w.Profile, Model: w.Model, Outcome: w.Outcome, Reason: w.Reason, At: w.At, DurationMS: w.DurationMS}
	if err := json.Unmarshal([]byte(w.Usage), &a.Usage); err != nil {
		return Attempt{}, fmt.Errorf("负责人 %s 的唤醒记录 %d 用量坏了：%w", w.Leader, w.ID, err)
	}
	return a, nil
}
