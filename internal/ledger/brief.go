package ledger

import (
	"context"
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// Brief 为执行者和审阅者读取同一份任务说明，附最近 20 条捎话（时间正序）。
// upto 是已带入说明的最后一条经历编号，供派活记录送达进度。
func Brief(ctx context.Context, q store.Querier, t Task) (detail string, upto int64, err error) {
	rows, err := q.QueryContext(ctx, `SELECT id, body FROM (SELECT id, body FROM task_events WHERE task = ? AND kind = 'tell' ORDER BY id DESC LIMIT 20) ORDER BY id`, t.ID)
	if err != nil {
		return "", 0, err
	}
	defer rows.Close()
	var b strings.Builder
	b.WriteString(strings.TrimSpace(t.Detail))
	first := true
	for rows.Next() {
		var text string
		if err := rows.Scan(&upto, &text); err != nil {
			return "", 0, err
		}
		if first {
			b.WriteString("\n\n### 之后的补充（以后面为准）\n\n")
			first = false
		}
		fmt.Fprintf(&b, "- %s\n", strings.TrimSpace(text))
	}
	if err := rows.Err(); err != nil {
		return "", 0, err
	}
	return strings.TrimSpace(b.String()), upto, nil
}
