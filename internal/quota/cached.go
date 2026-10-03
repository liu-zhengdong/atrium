package quota

import (
	"context"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// Cached 保留机器、来源指纹、套餐标签和原读数时刻，供可用性判定使用。
// 与 Last 共用存储读取；不启动额度读取器，不把 provider 摘要当当前账号或共享池事实。
func Cached(ctx context.Context, q store.Querier) ([]Stored, error) {
	return stored(ctx, q)
}

// CachedSources 是本机 OpenQuota 的完整原来源。失败保留原账号与成功时刻，
// 本次失败只标记陈旧，不将旧 matched 当作当前身份成功解析。远程来源没有
// pace 上报契约，不能把本机读数移用于其他机器。
func CachedSources(ctx context.Context, q store.Querier, now int64) ([]Pace, error) {
	st, err := openquotaStored(ctx, q)
	if err != nil {
		return nil, err
	}
	rows := agePaces(st.Rows, now)
	if st.Error != "" {
		for i := range rows {
			rows[i].Stale = true
			rows[i].CacheIdentityMatch = "unknown"
		}
	}
	return rows, nil
}
