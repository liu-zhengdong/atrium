package events

// 负责人唤醒（internal/org/leaders）用到的两处：上报事件的种类、唤醒连续失败后把没确认的事件转交上一层。
// 单独成文件，免得与本包主文件的改动冲突。

import (
	"context"
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// LeaderEscalate 是负责人上报；Body: {"from","kind","label","note","event"?,"original"?}。
const LeaderEscalate = "leader.escalate"

// Retarget 把 from 手上还没确认的这些事件改发给 to（清掉租约），返回改了几条。
// 转给秘书时只对本次转交的这几条按秘书的四类（SecretaryAct）重定级别：负责人接不住的任务仍要处理，完成回执、协作上报只知会。
// 全量重分类不在这里做——那会波及秘书名下其他事件，是服务启动时 Reclassify 的迁移工作。
func Retarget(ctx context.Context, q store.Querier, ids []int64, from, to string) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	in, idArgs := inClause(ids)
	// 先读这次要转的、确实要降级的 id；改投与降级同生同死（调用方在事务里）。正文坏只让这批里的那一条报错停下。
	var down []int64
	if to == Secretary {
		rows, err := q.QueryContext(ctx, `SELECT id, kind, body FROM events
			WHERE target = ? AND acked_at IS NULL AND id IN `+in, append([]any{from}, idArgs...)...)
		if err != nil {
			return 0, err
		}
		for rows.Next() {
			var id int64
			var kind, raw string
			if err := rows.Scan(&id, &kind, &raw); err != nil {
				rows.Close()
				return 0, err
			}
			act, err := secretaryAct(kind, raw)
			if err != nil {
				rows.Close()
				return 0, fmt.Errorf("事件 %d 正文：%w", id, err)
			}
			if !act {
				down = append(down, id)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return 0, err
		}
	}
	res, err := q.ExecContext(ctx, `UPDATE events SET target = ?, leased_until = NULL
		WHERE target = ? AND acked_at IS NULL AND id IN `+in, append([]any{to, from}, idArgs...)...)
	if err != nil {
		return 0, err
	}
	for _, id := range down {
		if _, err := q.ExecContext(ctx, `UPDATE events SET level = ? WHERE id = ?`, Info, id); err != nil {
			return 0, err
		}
	}
	return res.RowsAffected()
}

// inClause 生成「IN (?, ?, …)」与对应的参数。
func inClause(ids []int64) (string, []any) {
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return "(?" + strings.Repeat(", ?", len(ids)-1) + ")", args
}
