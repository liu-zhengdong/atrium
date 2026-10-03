package quota

import (
	"context"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// Cached 保留机器、账号指纹、套餐和读数时刻，供可用性判定使用。
// 与 Last 共用存储读取；不启动额度读取器，不把跨账号摘要当机器事实。
func Cached(ctx context.Context, q store.Querier) ([]Stored, error) {
	return stored(ctx, q)
}
