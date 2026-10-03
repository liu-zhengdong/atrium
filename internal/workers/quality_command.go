package workers

import (
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/cli"
)

const qualityHelp = "口径：只计有结果的拉起，强度合并；重试为 N>1（含换工具）；交回原因按原文分组。每次交付花费为全部拉起花费 / 交付数，含订阅折合与估算；仅完整 USD 读数可比，不换算其他货币。用时中位排除额度、起不来和其他失败。排序：交付率高、每次交付花费低、用时短；未知排后，同分按组合名。标「（负责人）」的行是负责人唤醒，排在任务拉起之后：一次唤醒算一次拉起，这批事件全确认算交付，没确认完（含超时、转交上一层）算其他失败，没拉起来算起不来；重试为上次没处理完后再唤醒。"

func qualityCmd(c *cli.Ctx) error {
	if err := c.MaxArgs(0); err != nil {
		return err
	}
	var rows []Quality
	if err := c.Call("GET", "/api/workers/quality", nil, &rows); err != nil {
		return err
	}
	var b strings.Builder
	if len(rows) == 0 {
		b.WriteString("还没有有结果的拉起记录\n")
	} else {
		b.WriteString("组合  拉起  交付  交付率  交回  重试占比  其他失败/额度/起不来  每次交付花费  用时中位\n")
		for _, q := range rows {
			fmt.Fprintf(&b, "%s  %d  %d  %.1f%%  %d  %.1f%%（%d）  %d/%d/%d  %s  %s\n", q.Name(), q.Launches, q.OK, q.DeliveryRate*100, q.Bounce, q.RetryRate*100, q.Retries, q.Fail, q.Quota, q.Setup, q.costText(), DurationText(q.MedianMS))
			writeBounceReasons(&b, q)
		}
	}
	fmt.Fprintf(&b, "\n%s\n", qualityHelp)
	return c.Done(rows, b.String(), "atrium workers <组合>")
}
