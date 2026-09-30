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
	out.UsageText = u.String()
	out.Trace.Usage = u
	return nil
}
