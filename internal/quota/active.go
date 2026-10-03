package quota

import (
	"context"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// DisabledAccounts 由 workers 装配：额度包不读取执行者档案。
// 每轮重新查询，使档案重新启用后自动恢复读取与显示。
var DisabledAccounts func(context.Context, store.Querier) (map[string]bool, error)

func Disabled(ctx context.Context, q store.Querier) (map[string]bool, error) {
	if DisabledAccounts == nil {
		return nil, nil
	}
	return DisabledAccounts(ctx, q)
}
