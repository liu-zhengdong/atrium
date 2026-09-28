package events

// 负责人唤醒（internal/org/leaders）用到的两处：上交事件的种类、唤醒连续失败后把没确认的事件转交上一层。
// 单独成文件，免得与本包主文件的改动冲突。

import (
	"context"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// LeaderEscalate 是负责人上交；Body: {"from","kind","label","note","event"?,"original"?}。
const LeaderEscalate = "leader.escalate"

// Retarget 把 from 手上还没确认的这些事件改投给 to（清掉租约），返回改了几条。
func Retarget(ctx context.Context, q store.Querier, ids []int64, from, to string) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	args := []any{to, from}
	for _, id := range ids {
		args = append(args, id)
	}
	res, err := q.ExecContext(ctx, `UPDATE events SET target = ?, leased_until = NULL
		WHERE target = ? AND acked_at IS NULL AND id IN (?`+strings.Repeat(", ?", len(ids)-1)+`)`, args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
