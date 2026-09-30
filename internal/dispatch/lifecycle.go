package dispatch

import (
	"context"
	"errors"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// Run 是派活循环：先接管服务重启前在跑的执行者，再等账本变化或定时，每次按队列顺序派。
func Run(ctx context.Context, env *app.Env) error {
	d := get(env)
	defer d.retired.Store(true)
	if err := d.adopt(ctx); err != nil {
		return err
	}
	needReclaim := true
	for {
		ch := ledger.Changed()
		if err := d.reap(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if needReclaim {
			if err := d.reclaim(ctx); err != nil {
				if ctx.Err() != nil {
					return nil
				}
				return err
			}
			needReclaim = d.reclaimAfter != 0 || d.reclaimDeferred
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
			needReclaim = true
		case <-d.kick:
			needReclaim = true
		case err := <-d.fatal:
			return err
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
	return ledger.EachTask(ctx, d.env.DB, "dispatch.reap", list, func(p *proc) string { return p.task }, func(p *proc) error {
		if p.stopReason() != "" {
			return nil
		}
		t, err := ledger.Get(ctx, d.env.DB, p.task)
		if err != nil {
			return err
		}
		if t.Status != ledger.Running || t.Stage != ledger.StageNone {
			p.setStop("gone")
			d.kill(ctx, p)
			return nil
		}
		last, err := workers.LastRun(ctx, d.env.DB, p.task)
		if err != nil {
			if app.InfrastructureError(ctx, d.env.DB, err) == nil {
				p.setStop("gone")
				d.kill(ctx, p)
			}
			return err
		}
		if last != nil && last.N == p.run.N {
			return nil
		}
		p.setStop("gone")
		d.kill(ctx, p)
		return nil
	})
}

// adoptProc 跟着已存在的进程等退出，本机与远程共用启动接管和终态补清的路径。
func (d *dispatcher) adoptProc(p *proc) {
	if p.remote {
		d.track(p, d.remoteWaiter(p, p.run.RemoteRun))
		return
	}
	d.track(p, func() int {
		for platform.Alive(p.run.PID) {
			time.Sleep(2 * time.Second)
		}
		return workers.ExitUnknown
	})
}
