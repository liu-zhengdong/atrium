package workers

import (
	"context"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Availability 是本轮缓存来源与标记快照，不读取凭据或云端。
// Readings 保留机器/provider 来源，不代表已关联当前执行组合的账号或共享池。
// t865 在 Launcher 注入侧复用；org 无需依赖 workers。
type Availability struct {
	Readings []quota.Stored
	// Sources 仅属于 quota.LocalHost；含完整来源事实，不证明执行组合绑定。
	Sources []quota.Pace
	Marks   []Mark
	Reserve int
	Now     int64
}

func LoadAvailability(ctx context.Context, env *app.Env) (Availability, error) {
	a := Availability{Now: store.Now()}
	var err error
	a.Readings, err = quota.Cached(ctx, env.DB)
	if err != nil {
		return a, err
	}
	a.Sources, err = quota.CachedSources(ctx, env.DB, a.Now)
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

// CheckResolved 共用 marks 与本轮已证实的执行绑定；没有绑定则额度未知。
// 对绑定来源逐窗复用 SpareOf/Reserve，token需求仅对明确分母的窗口生效。
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

// QuotaMarked 允许额度失败组合由具体机器的 mark 判定，而非全局 tried
// 连坐别的机器。另一机器的账号/套餐关系仍未知，恢复次数仍有界。
func (a Availability) QuotaMarked(s Spec) bool {
	for _, m := range a.Marks {
		if m.Kind == SignalQuota && (m.Until == 0 || m.Until > a.Now) && m.Covers(s) {
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
