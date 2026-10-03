package workers

import (
	"context"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// disabledQuotaAccounts：同一账号的所有组合都只接受点名时，退出额度版面。
func disabledQuotaAccounts(ctx context.Context, q store.Querier) (map[string]bool, error) {
	ids, err := Catalog(ctx, q)
	if err != nil {
		return nil, err
	}
	disabled := map[string]bool{}
	for _, id := range ids {
		r, err := Resolve(ctx, q, id)
		if err != nil {
			return nil, err
		}
		a := r.Account()
		if old, seen := disabled[a]; !seen || old {
			disabled[a] = !r.Rules.EffectiveAuto()
		}
	}
	return disabled, nil
}
