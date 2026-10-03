package ledger

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/store"
)

const taskLogRetention = 14 * 24 * time.Hour

// cleanupLogs 清理当前库旁的任务日志；启动、创建和终态收口共用，不清理任务资料。
func cleanupLogs(ctx context.Context, db *store.DB) error {
	var seq int
	var name, path string
	if err := db.QueryRowContext(ctx, "PRAGMA database_list").Scan(&seq, &name, &path); err != nil {
		return err
	}
	root := filepath.Join(filepath.Dir(path), "tasks")
	cutoff := store.Now() - taskLogRetention.Milliseconds()
	last := ""
	for {
		rows, err := db.QueryContext(ctx, `SELECT id FROM tasks WHERE status IN ('done', 'failed', 'cancelled')
			AND finished_at < ? AND id > ? ORDER BY id LIMIT 100`, cutoff, last)
		if err != nil {
			return err
		}
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			return nil
		}
		for _, id := range ids {
			logs, err := filepath.Glob(filepath.Join(root, id, "run-*.log"))
			if err != nil {
				return err
			}
			for _, log := range logs {
				st, err := os.Lstat(log)
				if os.IsNotExist(err) {
					continue
				}
				if err != nil {
					return err
				}
				if !st.Mode().IsRegular() {
					continue
				}
				if err := os.Remove(log); err != nil && !os.IsNotExist(err) {
					return err
				}
			}
		}
		last = ids[len(ids)-1]
	}
}

func cleanupStoredLogs(ctx context.Context, env *app.Env) error {
	return cleanupLogs(ctx, env.DB)
}
