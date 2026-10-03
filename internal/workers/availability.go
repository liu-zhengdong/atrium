package workers

import (
	"context"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Availability 是本轮缓存来源与标记快照，不读取凭据或云端。
// Readings 保留机器/provider 来源；只有 magpie 读数经执行绑定参与判定，其余不代表当前执行组合的账号或共享池。
// t865 在 Launcher 注入侧复用；org 无需依赖 workers。
type Availability struct {
	Readings []quota.Stored
	Marks    []Mark
	Reserve  int
	Now      int64
}

func LoadAvailability(ctx context.Context, env *app.Env) (Availability, error) {
	a := Availability{Now: store.Now()}
	var err error
	a.Readings, err = quota.Cached(ctx, env.DB)
	if err != nil {
		return a, err
	}
	a.Marks, err = Marks(ctx, env.DB, a.Now)
	if err != nil {
		return a, err
	}
	a.Reserve, err = quota.Reserve(ctx, env.DB)
	return a, err
}

// CheckResolved 共用 marks 与本轮执行绑定；没有绑定（直连）或那台机器没有新鲜 magpie 读数则额度未知。
// 有窗口到了给用户留的份额就不派（quota.MagpieSpare）；token 需求只对有 token 窗口的读数生效，magpie 不给。
// t865 可在 Launcher 注入侧调用 ResolveExecution/LoadAvailability/CheckResolved。
func (a Availability) CheckResolved(r Resolved, host string, tokens ...int64) (quota.Spare, string) {
	sp, why := a.Check(r.Spec, host)
	if why != "" {
		return sp, why
	}
	need := int64(0)
	if len(tokens) > 0 {
		need = tokens[0]
	}
	return a.checkBinding(r, host, need)
}

// Marked：这个组合此刻在某台机器上有不可用标记。被标记的组合由标记管退避（到期或解除后再试），
// 不再按「这一轮已试过」排除，也不连坐别的机器；另一机器的账号/套餐关系仍未知，换人次数仍有界。
func (a Availability) Marked(s Spec) bool {
	for _, m := range a.Marks {
		if (m.Until == 0 || m.Until > a.Now) && m.Covers(s) {
			return true
		}
	}
	return false
}

func (a Availability) Check(s Spec, host string) (quota.Spare, string) {
	sp := quota.Spare{}
	for _, m := range a.Marks {
		if m.Until > 0 && m.Until <= a.Now {
			continue
		}
		if m.Host != host {
			continue
		}
		// quota 没有模型范围时也不能推成这个工具的全部模型共享额度。
		if m.Kind == SignalQuota && m.Model == "" && s.Model != "" {
			continue
		}
		if m.Covers(s) {
			return sp, m.Text()
		}
	}
	return sp, ""
}
