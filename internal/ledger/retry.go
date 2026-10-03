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
// 临时失败按 RetryDelays 记一轮 loop_retry，间隔到期下一轮循环自然重做，
// 连续失败次数用尽才转受阻交处理人。间隔到期检查在 RetryHold，一处定义、
// 三处共用；等待中的任务让出循环。换延迟、加判定模式只改这个文件。
// 测试要快，改短 RetryDelays 即可。
var RetryDelays = []time.Duration{30 * time.Second, 2 * time.Minute, 8 * time.Minute}

// KindLoopRetry 记「第几轮重试、失败原因、隔多久」进任务经历：负责人在
// task log 里看得见为什么在等、等了多久、何时转受阻。
const KindLoopRetry = "loop_retry"

// KindLoopOK 记「重试后成功」：本操作的连续失败轮次从它之后重新计。
const KindLoopOK = "loop_ok"

// progressKinds 是「最近一次推进」的事件类：新任务、入队（人工重派）、开跑、
// 退出、过关卡、交回、完成、受阻、取消、改状态、交付，加上 loop_ok。连续失败
// 从最近一次推进之后、按操作计；任何推进发生，本操作的重试预算即重置。
const progressKinds = "('created','enqueue','start','exit_ok','exit_fail','gate_pass','review_pass','accept','bounce','land','block','cancel','set','deliver','loop_ok')"

// RetryOf 返回一件任务在该操作下、最近一次推进之后的连续重试轮数
// （loop_retry 记录条数）。推进之前旧的重试不计入：跨阶段、失败后成功、
// 受阻后重派都拿到完整预算。
func RetryOf(ctx context.Context, q store.Querier, id, operation string) (int, error) {
	var n int
	err := q.QueryRowContext(ctx,
		`SELECT count(1) FROM task_events WHERE task = ? AND kind = ? AND actor = ?
		 AND id > (SELECT COALESCE(max(id), 0) FROM task_events WHERE task = ? AND kind IN `+progressKinds+`)`,
		id, KindLoopRetry, operation, id).Scan(&n)
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

// RetryHold 判一件任务在该操作下是否该让出本轮循环：本操作已转受阻（最近的
// 推进之后有 loop_error），或最近一轮重试的间隔还没到期。EachTask 每轮开跑
// 前查；紧凑循环（合入队列 Drain）用它对队首提前收手，避免等待期间空转。
func RetryHold(ctx context.Context, q store.Querier, id, operation string) (bool, error) {
	var hold bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM task_events WHERE task = ? AND kind = ? AND actor = ?
	 AND id > (SELECT COALESCE(max(id), 0) FROM task_events WHERE task = ? AND kind IN `+progressKinds+`))`,
		id, KindLoopError, operation, id).Scan(&hold)
	if err != nil || hold {
		return hold, err
	}
	return retryWaiting(ctx, q, id, operation, store.Now())
}

// retryWaiting 判最近一轮重试的间隔是否还没到期。轮数与最近一次推进由同一条
// 查询取：最近一轮记于 at，共 n 轮，则第 n 轮的间隔是 RetryDelays[n-1]。
func retryWaiting(ctx context.Context, q store.Querier, id, operation string, now int64) (bool, error) {
	var at, n int64
	err := q.QueryRowContext(ctx,
		`SELECT COALESCE(max(at), 0), count(1) FROM task_events WHERE task = ? AND kind = ? AND actor = ?
		 AND id > (SELECT COALESCE(max(id), 0) FROM task_events WHERE task = ? AND kind IN `+progressKinds+`)`,
		id, KindLoopRetry, operation, id).Scan(&at, &n)
	if err != nil || n == 0 {
		return false, err
	}
	if n > int64(len(RetryDelays)) {
		n = int64(len(RetryDelays))
	}
	return now < at+RetryDelays[n-1].Milliseconds(), nil
}
