package web

import (
	"context"

	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func taskUsage(ctx context.Context, q store.Querier, id string, run workers.Run, out *TaskDetail) error {
	if out.Live {
		return nil
	}
	u, err := workers.ExitUsage(ctx, q, id, run.N)
	if err != nil {
		return err
	}
	out.UsageText = usageText(u)
	out.Trace.Usage = u
	return nil
}

// usageText 是抽屉「拉起用量」一行；四项 token 与花费都读不到时给空，整块不出（一行「读不到」没有信息）。
func usageText(u workers.Usage) string {
	if u.Input == nil && u.Output == nil && u.CacheRead == nil && u.CacheWrite == nil && u.Cost == nil {
		return ""
	}
	return u.String()
}
