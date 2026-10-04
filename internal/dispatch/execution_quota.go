package dispatch

import (
	"context"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// quotaReset：额度用尽而报文没写恢复时刻时，经 magpie 的组合按 magpie 窗口的重置时间定恢复（重试节奏）；
// 读数未知仍按 workers.Hold。
func (d *dispatcher) quotaReset(ctx context.Context, p *proc, sig workers.Signal) (workers.Signal, error) {
	if sig.Kind != workers.SignalQuota || sig.ResetAt != 0 || p.binding == nil {
		return sig, nil
	}
	a, err := workers.LoadAvailability(ctx, d.env)
	if err != nil {
		return sig, err
	}
	sig.ResetAt = a.QuotaReset(p.binding)
	return sig, nil
}

// 已证实共享池才将同一个失败标记写给实际成员。无绑定/服务重启后只沿用
// 原组合 mark；不重新解析失败进程的旧身份，不清标，不延长保留期。
func (d *dispatcher) markSharedFailure(ctx context.Context, p *proc, sig workers.Signal) error {
	if sig.Kind != workers.SignalQuota || p.binding == nil {
		return nil
	}
	base, err := workers.ParseWorker(p.run.Worker)
	if err != nil {
		return err
	}
	now := store.Now()
	marks, err := workers.Marks(ctx, d.env.DB, now)
	if err != nil {
		return err
	}
	var active int
	if err := d.env.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM worker_marks WHERE until=0 OR until>?`, now).Scan(&active); err != nil {
		return err
	}
	if active != len(marks) {
		return api.Conflict("共享池标记列表不完整：%d/%d", len(marks), active)
	}
	targets := map[string]bool{}
	for _, mark := range marks {
		targets[mark.Target()] = true
	}
	var pending []workers.Mark
	var m workers.Mark
	for _, mark := range marks {
		if mark.Host == p.run.Host && mark.Tool == base.Tool && mark.Model == base.Model && mark.Kind == workers.SignalQuota {
			m = mark
			break
		}
	}
	if m.Tool == "" {
		return nil
	}
	pending, err = d.sharedMarks(ctx, p.binding, m, targets)
	if err != nil {
		return err
	}

	for _, member := range pending {
		if err := workers.SetMark(ctx, d.env.DB, member); err != nil {
			return err
		}
	}
	return nil
}

// sharedMarks 先完整计划，超过已有 500 marks 预算不写部分扩展结果。
func (d *dispatcher) sharedMarks(ctx context.Context, binding *workers.ExecutionBinding, m workers.Mark, targets map[string]bool) ([]workers.Mark, error) {
	machines, err := hosts.List(ctx, d.env.DB)
	if err != nil {
		return nil, err
	}
	var count int
	if err := d.env.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM hosts`).Scan(&count); err != nil {
		return nil, err
	}
	if count != len(machines) {
		return nil, api.Conflict("共享池成员机器列表不完整：%d/%d，未扩展标记", len(machines), count)
	}
	machineIDs := make([]string, 0, len(machines))
	for _, host := range machines {
		machineIDs = append(machineIDs, host.ID)
	}
	return workers.PlanPoolMarks(ctx, d.env, binding, m, machineIDs, targets)
}

// CheckExecution 供 Launcher 注入侧与实际启动入口复用，不要求 org 依赖 workers。
func CheckExecution(ctx context.Context, env *app.Env, r workers.Resolved, host string, tokens int64) (workers.Resolved, error) {
	r, err := workers.ResolveExecution(ctx, env, r, host)
	if err != nil {
		return r, err
	}
	if !r.QuotaBinding.Valid(r, host) {
		r.QuotaBinding = nil
	}
	a, err := workers.LoadAvailability(ctx, env)
	if err != nil {
		return r, err
	}
	sp, why := a.CheckResolved(r, host, tokens)
	if why == "" {
		why = sp.Stop
	}
	if why != "" {
		return r, api.Conflict("%s 接不了：%s", r.ID, why)
	}
	return r, nil
}
