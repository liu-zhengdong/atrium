package quota

import (
	"context"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// Cached 保留机器、来源指纹、套餐标签和原读数时刻，供可用性判定使用（含 magpie 读数，判定见 MagpieSpare）。
// 只读缓存；不启动额度读取器，不把 provider 摘要当当前账号或共享池事实。
func Cached(ctx context.Context, q store.Querier) ([]Stored, error) {
	return stored(ctx, q)
}
