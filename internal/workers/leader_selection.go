package workers

import (
	"context"
	"fmt"
	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/org/leaders"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"slices"
	"strings"
)

// 负责人始终在服务本机启动。首选可用即返回；替代档先保能力再比较已声明成本。
func selectLeader(ctx context.Context, env *app.Env, l leaders.Launch) (Resolved, error) {
	base, err := Resolve(ctx, env.DB, l.Profile)
	if err != nil {
		return base, err
	}
	ids, err := Catalog(ctx, env.DB)
	if err != nil {
		return base, err
	}
	a, err := LoadAvailability(ctx, env)
	if err != nil {
		return base, err
	}
	ids = append(slices.Clone(l.Attempt.Preferred), ids...)
	seen := map[string]bool{}
	var candidates []Resolved
	var reasons []string
	for _, id := range ids {
		r, err := Resolve(ctx, env.DB, id)
		if err != nil {
			var ae *api.Error
			if !asAPI(err, &ae) {
				return r, err
			}
			reasons = append(reasons, id+": "+err.Error())
			continue
		}
		if seen[r.ID] {
			continue
		}
		seen[r.ID] = true
		r, err = ResolveExecution(ctx, env, r, quota.LocalHost)
		if err != nil {
			return r, err
		}
		if !r.QuotaBinding.Valid(r, quota.LocalHost) {
			r.QuotaBinding = nil
		}
		why := leaderRefusal(base, r, slices.Contains(l.Attempt.Tried, r.ID))
		if why == "" {
			sp, mark := a.CheckResolved(r, quota.LocalHost)
			why = mark
			if why == "" {
				why = sp.Stop
			}
		}
		if why == "" {
			_, err := platform.LookPath(r.Adapter.Exe, l.Env)
			if err != nil {
				why = "工具未安装"
			}
		}
		if why == "" {
			if err := r.Check(); err != nil {
				why = err.Error()
			}
		}
		if why != "" {
			reasons = append(reasons, r.ID+": "+why)
			continue
		}
		if r.ID == base.ID {
			return r, nil
		}
		candidates = append(candidates, r)
	}
	for i := range candidates {
		for j := i + 1; j < len(candidates); j++ {
			if Cheaper(candidates[j].Rules, candidates[i].Rules) {
				candidates[i], candidates[j] = candidates[j], candidates[i]
			}
		}
	}
	if len(candidates) > 0 {
		return candidates[0], nil
	}
	return Resolved{}, fmt.Errorf("没有可用负责人执行者（拒绝 %d 档）：%s", len(reasons), strings.Join(reasons[:min(3, len(reasons))], "；"))
}
