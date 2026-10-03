package leaders

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// 唤醒记录（leader_wakes）：一次唤醒拉起一条，保留 WakeRetention；workers 读它与任务拉起一起算执行者质量。

// 结果取值与任务拉起同一套（workers.OutOK、OutFail、OutSetup；workers 的测试核对），本包引不到 workers。
const (
	WakeOK    = "ok"    // 这批全确认了
	WakeFail  = "fail"  // 没确认完：剩下几件、超时、转交上一层
	WakeSetup = "setup" // 没拉起来：拉起接口没接上、档案解析不了、进程起不来
)

// Wake 是一条唤醒记录。Usage 是 workers.Usage 的 JSON，由 WakeUsage 给出。
type Wake struct {
	ID         int64
	Leader     string
	Profile    string
	N          int
	Model      string
	Outcome    string
	Reason     string
	Usage      string
	DurationMS *int64
	At         int64
}

// WakeUsage 从这次唤醒的日志段取工具报的实际模型与用量（workers 在 hook 里接上，按档案解析与结算）；单测里保持为空。
var WakeUsage = func(ctx context.Context, q store.Querier, profile, log string) (model, usage string, err error) {
	return "", "", nil
}

// WakeResult 纯判定一次唤醒的结果：没拉起来算起不来；这批全确认算成功（进程出错退出也算）；
// 否则算失败，原因写剩几件、进程的错误（含超时）与转交给了谁。
func WakeResult(started bool, err error, left, total int, forwardTo []string) (outcome, reason string) {
	if !started {
		if err == nil {
			return WakeSetup, ""
		}
		return WakeSetup, err.Error()
	}
	if left == 0 {
		return WakeOK, ""
	}
	parts := []string{fmt.Sprintf("没确认 %d/%d 件", left, total)}
	if err != nil {
		parts = append(parts, err.Error())
	}
	if len(forwardTo) > 0 {
		parts = append(parts, "已转交 "+strings.Join(forwardTo, "、"))
	}
	return WakeFail, strings.Join(parts, "；")
}

func recordWake(ctx context.Context, db *store.DB, w Wake) error {
	if w.Usage == "" {
		w.Usage = "{}"
	}
	return db.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO leader_wakes (leader, profile, n, model, outcome, reason, usage, duration_ms, at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, w.Leader, w.Profile, w.N, w.Model, w.Outcome, w.Reason, w.Usage, w.DurationMS, w.At)
		return err
	})
}

// WakeRetention 是唤醒记录的保留期：质量统计只算这段时间内的唤醒，过期的由唤醒循环每小时删掉（PruneWakes）。
// 量级：每天几十次唤醒，保留期内几千条；30 天也跟得上工具与模型的更替，更早的不代表现在的质量。
const WakeRetention = 30 * 24 * time.Hour

// PruneWakes 删掉早于 before 的唤醒记录，返回删了几条。
func PruneWakes(ctx context.Context, q store.Querier, before int64) (int64, error) {
	res, err := q.ExecContext(ctx, `DELETE FROM leader_wakes WHERE at < ?`, before)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ReadWakes 分页读 since（毫秒）及之后的唤醒记录（按编号正序）。调用方传 now - WakeRetention，
// 口径就不受清理是否已跑到的影响。
func ReadWakes(ctx context.Context, q store.Querier, since int64) ([]Wake, error) {
	var out []Wake
	var cursor int64
	for {
		rows, err := q.QueryContext(ctx, `SELECT id, leader, profile, n, model, outcome, reason, usage, duration_ms, at
			FROM leader_wakes WHERE id > ? AND at >= ? ORDER BY id LIMIT 1000`, cursor, since)
		if err != nil {
			return nil, err
		}
		n := 0
		for rows.Next() {
			var w Wake
			var d sql.NullInt64
			if err := rows.Scan(&w.ID, &w.Leader, &w.Profile, &w.N, &w.Model, &w.Outcome, &w.Reason, &w.Usage, &d, &w.At); err != nil {
				rows.Close()
				return nil, err
			}
			if d.Valid {
				w.DurationMS = &d.Int64
			}
			cursor = w.ID
			out = append(out, w)
			n++
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		if n < 1000 {
			return out, nil
		}
	}
}
