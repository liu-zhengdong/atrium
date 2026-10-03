package agenda

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
)

const dueBatch = 100

// 复用 last_note 保留失败原因并停止自动重试，schedule run 成功后清掉。
const scheduleLoopError = "后台处理出错："

// Tick 巡检一次到点的定时任务。暂停范围内的不动（下一轮时间不变，恢复后只补一轮；一次性的恢复后补这一次）。
func Tick(ctx context.Context, env *app.Env, now int64, loc *time.Location) error {
	rows, err := env.DB.QueryContext(ctx, `SELECT `+scheduleCols+` FROM schedules WHERE next_at <= ? AND last_note NOT LIKE ? ORDER BY next_at LIMIT ?`, now, scheduleLoopError+"%", dueBatch)
	if err != nil {
		return err
	}
	var due []Schedule
	for rows.Next() {
		x, err := scanSchedule(rows)
		x.scanErr = err
		due = append(due, x)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	return app.Each(ctx, env.DB, due, func(x Schedule) error {
		if x.scanErr != nil {
			return x.scanErr
		}
		if !x.Once {
			if _, err := ParseEvery(x.Every); err != nil {
				return fmt.Errorf("%s 的周期间隔不合法：%w", x.ID, err)
			}
		}
		if x.atMinute != nil {
			if _, err := ParseAt(x.At, x.EveryMs); err != nil {
				return fmt.Errorf("%s 的钟点不合法：%w", x.ID, err)
			}
		}
		chain, err := org.Ancestors(ctx, env.DB, x.Org)
		if err != nil {
			return err
		}
		if paused, err := env.Pause.Paused(ctx, pause.Scope{Orgs: chain}); err != nil || paused {
			if err != nil {
				return err
			}
			return nil
		}
		open, err := openRound(ctx, env.DB, x)
		if err != nil {
			return err
		}
		v := Due(x.NextAt, x.EveryMs, x.atMinute, open, now, loc)
		missed := ""
		if v.Missed > 0 {
			missed = fmt.Sprintf("（停机错过 %d 轮，只补这一轮）", v.Missed)
		}
		day := time.UnixMilli(now).In(loc).Format("01-02 15:04")
		switch v.Kind {
		case "skip":
			if _, err := env.DB.ExecContext(ctx, `UPDATE schedules SET next_at = ?, skips = skips + 1, last_note = ? WHERE id = ?`,
				v.Next, fmt.Sprintf("%s 上一轮 %s 没结束，跳过%s", day, v.Open, missed), x.ID); err != nil {
				return err
			}
		case "run":
			task, err := runRound(ctx, env, x, v.Next, day+" 到点生成"+missed, now, loc)
			if err != nil && task.ID != "" {
				return ledger.EachTask(ctx, env.DB, "agenda.enqueue", []ledger.Task{task}, func(t ledger.Task) string { return t.ID }, func(ledger.Task) error { return err })
			}
			if err != nil {
				return err
			}
		}
		return nil
	}, func(x Schedule, cause error) error {
		note := scheduleLoopError + cause.Error() + "；修正后用 atrium schedule run " + x.ID + " 重试"
		return env.DB.Tx(ctx, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, `UPDATE schedules SET last_note = ? WHERE id = ?`, note, x.ID); err != nil {
				return err
			}
			target, err := org.Recipient(ctx, tx, x.Org)
			if err != nil {
				return err
			}
			return events.Emit(ctx, tx, events.Event{Kind: events.ScheduleFail, Target: target, Dept: x.Org, Key: "schedule.failed:" + x.ID, Level: events.Act, Body: map[string]any{"schedule": x.ID, "note": note}})
		})
	})
}

// 有定时任务新建时唤醒巡检循环重新算等多久。
var (
	wakeMu sync.Mutex
	wakeCh = make(chan struct{}, 1)
)

func wake() {
	wakeMu.Lock()
	defer wakeMu.Unlock()
	select {
	case wakeCh <- struct{}{}:
	default:
	}
}

// Run 是定时任务的后台循环：睡到最早的下一轮（最多一分钟），醒来巡检一次。
func Run(ctx context.Context, env *app.Env) error {
	for {
		if err := Tick(ctx, env, store.Now(), time.Local); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		wait := time.Minute
		var next sql.NullInt64
		if err := env.DB.QueryRowContext(ctx, `SELECT min(next_at) FROM schedules WHERE last_note NOT LIKE ?`, scheduleLoopError+"%").Scan(&next); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if next.Valid {
			wait = min(wait, max(time.Duration(next.Int64-store.Now())*time.Millisecond, time.Second))
		}
		select {
		case <-ctx.Done():
			return nil
		case <-wakeCh:
		case <-time.After(wait):
		}
	}
}
