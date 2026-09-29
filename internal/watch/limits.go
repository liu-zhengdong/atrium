package watch

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// checkLimits 巡检一轮顺带数各部门与全局的上限用量：刚到或超了就给该整理的人发一条要处理的事件。
func checkLimits(ctx context.Context, env *app.Env) error {
	emit, clear, err := org.ScanNotices(ctx, env.DB)
	if err != nil {
		return err
	}
	for _, n := range emit {
		if err := emitLimit(ctx, env.DB, n); err != nil {
			return fmt.Errorf("上限 %s %s：%w", n.Scope, n.Limit.Key, err)
		}
	}
	for _, r := range clear {
		if err := org.ForgetNotice(ctx, env.DB, r.Scope, r.Key); err != nil {
			return fmt.Errorf("清上限已提醒 %s %s：%w", r.Scope, r.Key, err)
		}
	}
	return nil
}

func emitLimit(ctx context.Context, db *store.DB, n org.LimitNotice) error {
	l := n.Limit
	body := map[string]any{
		"key": l.Key, "what": l.What, "used": n.Used, "max": l.Max, "unit": l.Unit,
		"fix": org.NoticeFix(l, n.Scope), "next": org.NoticeNext(l, n.Scope),
		"text": org.NoticeText(l, n.Scope, n.Used),
	}
	return db.Tx(ctx, func(tx *sql.Tx) error {
		if err := events.Emit(ctx, tx, events.Event{
			Kind: events.LimitFull, Dept: n.Scope, Target: n.Target, Key: n.EventKey(),
			Level: events.Act, Body: body,
		}); err != nil {
			return err
		}
		return org.RecordNotice(ctx, tx, n.Scope, l.Key, n.Used)
	})
}
