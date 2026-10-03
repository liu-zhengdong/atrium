package dispatch

import (
	"cmp"
	"context"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
	"time"
)

// tries 数这一轮（最近一次从队列取出之后）同一执行者重试、换人各几次，以及试过的执行者。
func tries(runs []workers.Run) (same, switches int, tried map[string]bool) {
	tried = map[string]bool{}
	for i := len(runs) - 1; i >= 0; i-- {
		r := runs[i]
		tried[r.Worker] = true
		switch r.Why {
		case workers.WhySame:
			same++
		case workers.WhySwitch:
			switches++
		case workers.WhyFirst, workers.WhyBounce: // 交回后是新的一轮
			return
		}
	}
	return
}

// markUnavailable 按退出信号把这一轮的「工具+模型@机器」标成不可用，返回写进任务备注的一句；不是可用性信号返回空。
func markUnavailable(ctx context.Context, db *store.DB, run workers.Run, sig workers.Signal) (string, error) {
	w, err := workers.ParseWorker(run.Worker)
	if err != nil {
		return "", err
	}
	m, ok := workers.MarkOf(sig, w, cmp.Or(run.Host, LocalHost), time.Now())
	if !ok {
		return "", nil
	}
	if err := workers.SetMark(ctx, db, m); err != nil {
		return "", err
	}
	return "；已标记 " + m.Target() + " 不可用（" + m.Text() + "）", nil
}
