package hosts

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/org"
)

// usableHosts 给后台维持隧道与分派任务挑机器。坏登记留在原处并交秘书，
// 其余机器照常使用；按错误原因去重，服务重启也不会每轮刷屏。
func usableHosts(ctx context.Context, env *app.Env) ([]Host, error) {
	rows, err := hostRows(ctx, env.DB)
	if err != nil {
		return nil, app.Global(err)
	}
	out := make([]Host, 0, len(rows))
	err = app.Each(ctx, env.DB, rows, func(row hostRow) error {
		if row.err != nil {
			return row.err
		}
		out = append(out, row.host)
		return nil
	}, func(row hostRow, cause error) error {
		key := "host.record:" + row.host.ID + ":" + digest(cause.Error())
		seen, err := events.Seen(ctx, env.DB, org.Secretary, key)
		if err != nil || seen {
			return err
		}
		note := fmt.Sprintf("机器 %s 登记出错：%v；修正登记后再使用", row.host.ID, cause)
		setTunnel(row.host.ID, note)
		env.Log.Warn("机器登记出错", "host", row.host.ID, "err", cause)
		return env.DB.Tx(ctx, func(tx *sql.Tx) error {
			return events.Emit(ctx, tx, events.Event{Kind: events.HostRecord, Target: org.Secretary, Key: key, Level: events.Act, Body: map[string]any{"host": row.host.ID, "note": note}})
		})
	})
	return out, app.Global(err)
}
