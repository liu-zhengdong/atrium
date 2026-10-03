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

// CheckResolved 只用已证实的失败组合/机器。当前读数没有当前解析凭据匹配及
// 模型/共享池成员证据，不能把工具、provider、Finger 或套餐名当关联事实。
// Spare 保持未知；来源补齐后由此入口关联，展示 Last 不参与调度。
func (a Availability) CheckResolved(r Resolved, host string) (quota.Spare, string) {
	return a.Check(r.Spec, host)
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
