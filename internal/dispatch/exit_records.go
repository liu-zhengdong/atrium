package dispatch

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// recordExit 记这次拉起的结果（workers 按拉起统计用）。
func recordExit(ctx context.Context, db *store.DB, task string, run workers.Run, x workers.Exit) error {
	u, err := workers.RunUsage(ctx, db, task, run)
	if err != nil {
		return err
	}
	x.Usage = u
	raw, _ := json.Marshal(x)
	return db.Tx(ctx, func(tx *sql.Tx) error {
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM task_events WHERE task = ? AND kind = ? AND json_extract(body,'$.n') = ? LIMIT 1)`, task, workers.ExitKind, run.N).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return nil
		}
		return ledger.Record(ctx, tx, task, workers.ExitKind, actor, string(raw))
	})
}
