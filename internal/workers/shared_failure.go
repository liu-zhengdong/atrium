package workers

import (
	"context"
	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
)

// PlanPoolMarks 供任务退出与负责人退出共同计划已证实的共享池成员。
// 调用方提供其实际启动机器范围，marks 预算与原期限在此统一维护。
func PlanPoolMarks(ctx context.Context, env *app.Env, binding *ExecutionBinding, m Mark, hosts []string, targets map[string]bool) ([]Mark, error) {
	ids, err := Catalog(ctx, env.DB)
	if err != nil {
		return nil, err
	}
	var pending []Mark
	for _, id := range ids {
		r, err := Resolve(ctx, env.DB, id)
		if err != nil {
			var ae *api.Error
			if asAPI(err, &ae) {
				continue
			}
			return nil, err
		}
		for _, host := range hosts {
			memberResolved, err := ResolveExecution(ctx, env, r, host)
			if err != nil {
				return nil, err
			}
			if !memberResolved.QuotaBinding.Valid(memberResolved, host) || !SamePool(binding, memberResolved.QuotaBinding) {
				continue
			}
			member := m
			member.Host, member.Tool, member.Model = host, memberResolved.Spec.Tool, memberResolved.Spec.Model
			if targets[member.Target()] {
				continue
			}
			if len(targets) >= 500 {
				return nil, api.Conflict("共享池标记超限：需要超过 500 条，未扩展标记")
			}
			targets[member.Target()] = true
			pending = append(pending, member)
		}
	}
	return pending, nil
}
