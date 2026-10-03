package ledger

import (
	"context"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 一批不超过 task ls 的最大页；更大的树由呈现端分批读取。
const partiesBatchSize = 500

func partyIDs(raw string) ([]string, error) {
	ids := strings.Split(raw, ",")
	if len(ids) > partiesBatchSize {
		return nil, api.Usage("ids: 每批最多 %d 件任务", partiesBatchSize)
	}
	for _, id := range ids {
		if !api.IsRef(id, "t") {
			return nil, api.Usage("ids: 应为逗号分隔的 tN 短号，收到 %q", id)
		}
	}
	return ids, nil
}

// readParties 只读角色事实，不读经历列表、依赖或子树；判定仍只有 PartiesOf 一份。
func readParties(ctx context.Context, q store.Querier, ids []string) (map[string]Parties, error) {
	out := make(map[string]Parties, len(ids))
	for _, id := range ids {
		if _, ok := out[id]; ok {
			continue
		}
		var exists int
		if err := q.QueryRowContext(ctx, `SELECT 1 FROM tasks WHERE id = ?`, id).Scan(&exists); err != nil {
			if store.IsNotFound(err) {
				return nil, api.NotFound("任务 %s 不存在", id)
			}
			return nil, err
		}
		p, err := PartiesOf(ctx, q, id)
		if err != nil {
			return nil, err
		}
		out[id] = p
	}
	return out, nil
}
