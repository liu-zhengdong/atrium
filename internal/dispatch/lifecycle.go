package dispatch

import (
	"context"
	"errors"
	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/workers"
	"time"
)

// Run 是派活循环：先接管服务重启前在跑的执行者，再等账本变化或定时，每次按队列顺序派。
func Run(ctx context.Context, env *app.Env) error {
	d := get(env)
	defer d.retired.Store(true)
	if err := d.adopt(ctx); err != nil {
		return err
	}
	for {
		ch := ledger.Changed()
		if err := d.reap(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if err := d.pump(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ch:
		case <-d.kick:
		case <-time.After(10 * time.Second): // 暂停解除、额度恢复、机器空出来不经账本
		}
	}
}

func isAPI(err error) bool {
	var ae *api.Error
	return errors.As(err, &ae)
}

// reap 结束已不该跑的执行者：任务被人改成受阻、取消、完成（task set），或被 watch 收了尾，进程还活着就结束它。
func (d *dispatcher) reap(ctx context.Context) error {
	d.mu.Lock()
	list := make([]*proc, 0, len(d.procs))
	for _, p := range d.procs {
		list = append(list, p)
	}
	d.mu.Unlock()
	for _, p := range list {
		if p.stopReason() != "" {
			continue
		}
		t, err := ledger.Get(ctx, d.env.DB, p.task)
		if err != nil {
			return err
		}
		last, err := workers.LastRun(ctx, d.env.DB, p.task)
		if err != nil {
			return err
		}
		if t.Status == ledger.Running && t.Stage == ledger.StageNone && last != nil && last.N == p.run.N {
			continue
		}
		p.setStop("gone")
		d.kill(ctx, p)
	}
	return nil
}
