package ledger

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// 运行时与外部服务（gh、git 远端）交互偶发失败：unexpected EOF、git fetch 的
// RPC failed、push --force-with-lease 的 stale info 都在下一轮自愈，不该每次
// 瞬断就转受阻、耗一次唤醒加一次执行者拉起。关卡、dispatch、合入队列三处都
// 经 EachTask 处理单件错误，重试只挂在 EachTask：Transient 判定临时错误，
// 临时失败先记一轮 loop_retry（下一轮循环自然重做），连续失败次数用尽才转
// 受阻交处理人。策略一处定义、三处共用；换延迟、加判定模式只改这个文件。
// 测试要快，改短 RetryDelays 即可。
var RetryDelays = []time.Duration{30 * time.Second, 2 * time.Minute, 8 * time.Minute}

// KindLoopRetry 记「第几轮重试、失败原因、隔多久」进任务经历：负责人在
// task log 里看得见为什么在等、等了多久、何时转受阻。
const KindLoopRetry = "loop_retry"

// RetryOf 返回一件任务已记的重试轮数（loop_retry 记录条数）。
func RetryOf(ctx context.Context, q store.Querier, id string) (int, error) {
	var n int
	err := q.QueryRowContext(ctx,
		`SELECT count(1) FROM task_events WHERE task = ? AND kind = ?`, id, KindLoopRetry).Scan(&n)
	return n, err
}

// retryNote 是记进经历的结论：失败原因、隔多久再试、第几轮。
func retryNote(operation string, cause error, round int) string {
	return fmt.Sprintf("%s 临时失败（%v），%s 后第 %d/%d 轮重试",
		operation, cause, RetryDelays[round-1], round, len(RetryDelays))
}

// Transient 判外部错误是不是临时的：网络瞬断、竞态（force-with-lease 被拒）
// 这类下一轮多半自愈。gh、git 的报错到不了这里时只剩字符串，只认字面：
// 大小写不敏感、包含即中。
func Transient(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, s := range transientHints {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

// transientHints 来自真实现场（t691 unexpected EOF、t704 RPC failed、
// t882 stale info）加通用网络错误集。
var transientHints = []string{
	"eof",
	"rpc failed",
	"stale info",
	"unable to access",
	"connection refused",
	"connection reset",
	"connection timed out",
	"i/o timeout",
	"tls handshake timeout",
	"could not resolve host",
	"temporary failure in name resolution",
}
