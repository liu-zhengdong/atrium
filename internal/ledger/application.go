package ledger

import (
	"context"
	"github.com/liu-zhengdong/atrium/internal/store"
)

type applicationKey struct{}

// Application 串行化任务决定、交付变更与实际应用。锁只存在于本服务实例，
// 决定提交与不可撤回的应用有明确先后；运行时唯一写者的约束由服务维持。
func Application(ctx context.Context, db *store.DB, fn func(context.Context) error) error {
	ctx, unlock := applicationLock(ctx, db)
	defer unlock()
	return fn(ctx)
}
func applicationLock(ctx context.Context, db *store.DB) (context.Context, func()) {
	if ctx.Value(applicationKey{}) == db {
		return ctx, func() {}
	}
	db.ApplicationMu.Lock()
	return context.WithValue(ctx, applicationKey{}, db), db.ApplicationMu.Unlock
}
