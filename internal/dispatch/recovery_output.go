package dispatch

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"

	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// hasRunDelivery 只把本次拉起后运行时登记的 PR 当成本轮产出，旧 PR
// 不能掩盖一次空转。事实仍在 ledger，不另存基线或产出状态。
func hasRunDelivery(ctx context.Context, q store.Querier, task string, run workers.Run) (bool, error) {
	if hasRunOutput(run) {
		return true, nil
	}
	var fresh bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM task_events WHERE task = ? AND kind = 'facts'
		AND json_extract(body,'$.PR') != '' AND id > COALESCE((SELECT max(id) FROM task_events
		WHERE task = ? AND kind = ? AND json_extract(body,'$.n') = ?),0) LIMIT 1)`, task, task, workers.RunKind, run.N).Scan(&fresh)
	return fresh, err
}

// hasRunOutput 只查本次工作目录的文件时刻，不读文件内容、不访问用户登录。
// 有新写入文件是产出证据；远程靠日志动作/任务 PR 判定。扫描超过 500 项或
// 读不全时保持未知（按有产出处理），不能把未观察到冒充没有。
func hasRunOutput(run workers.Run) bool {
	if run.Host != LocalHost || run.Dir == "" {
		return false
	}
	seen := 0
	found := false
	err := filepath.WalkDir(run.Dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Name() == ".git" {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		seen++
		if seen > 500 {
			return errors.New("产出扫描达到上限")
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.ModTime().UnixMilli() >= run.At {
			found = true
			return fs.SkipAll
		}
		return nil
	})
	return found || err != nil
}
