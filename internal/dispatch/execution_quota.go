package dispatch

import (
	"context"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

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
	ids, err := workers.Catalog(ctx, d.env.DB)
	if err != nil {
		return nil, err
	}
	var pending []workers.Mark
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
	for _, id := range ids {
		r, err := workers.Resolve(ctx, d.env.DB, id)
		if err != nil {
			if isAPI(err) {
				continue
			}
			return nil, err
		}
		for _, host := range machines {
			memberResolved, err := workers.ResolveExecution(ctx, d.env, r, host.ID)
			if err != nil {
				return nil, err
			}
			if !memberResolved.QuotaBinding.Valid(memberResolved, host.ID) || !workers.SamePool(binding, memberResolved.QuotaBinding) {
				continue
			}
			member := m
			member.Host, member.Tool, member.Model = host.ID, memberResolved.Spec.Tool, memberResolved.Spec.Model
			if targets[member.Target()] {
				continue
			} // 已有标记不重写或延长
			if len(targets) >= 500 {
				return nil, api.Conflict("共享池标记超限：需要超过 500 条，未扩展标记")
			}
			targets[member.Target()] = true
			pending = append(pending, member)
		}
	}

	return pending, nil
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
