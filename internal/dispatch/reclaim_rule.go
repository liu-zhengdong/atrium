package dispatch

import "github.com/liu-zhengdong/atrium/internal/ledger"

// Reclaimable 与 Finished 不同：failed 可自动续跑，要保留未推送的改动；done/cancelled 只有人工重开才能回来。
func Reclaimable(status ledger.Status) bool {
	return status == ledger.Done || status == ledger.Cancelled
}
