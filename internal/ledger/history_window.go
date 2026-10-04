package ledger

import (
	"github.com/liu-zhengdong/atrium/internal/api"
	"strconv"
)

func historyWindow(size, cursor string) (int, int64, error) {
	limit := 20
	if size != "" {
		n, err := strconv.Atoi(size)
		if err != nil || n < 1 || n > 100 {
			return 0, 0, api.Usage("history-limit: 应为1到100的整数")
		}
		limit = n
	}
	var before int64
	if cursor != "" {
		n, err := strconv.ParseInt(cursor, 10, 64)
		if err != nil || n < 0 {
			return 0, 0, api.Usage("before: 应为非负经历ID")
		}
		before = n
	}
	return limit, before, nil
}
