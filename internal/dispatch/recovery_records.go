package dispatch

import (
	"cmp"
	"context"
	"encoding/json"
	"slices"
	"time"

	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// tries 数这一轮（最近一次从队列取出之后）同一执行者重试、换人各几次，以及试过的执行者。
func tries(runs []workers.Run) (same, switches int, tried map[string]bool) {
	tried = map[string]bool{}
	for i := len(runs) - 1; i >= 0; i-- {
		r := runs[i]
		if r.Why == workers.WhyReview {
			continue
		}
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

// retryOpts 是换人放回队列的选项：沿用上一轮拉起的风险、凭据与 token 需求；Switch 让换人次数接着这一轮数。
func retryOpts(run *workers.Run, tried map[string]bool, marked func(workers.Spec) bool) Options {
	o := Options{Risk: "low", Switch: true, Avoid: avoidOf(tried, marked)}
	if run != nil {
		o.Risk, o.Secrets, o.Tokens = run.Risk, run.Secrets, run.Tokens
	}
	return o
}

// avoidOf 是放回队列后要避开的执行者（纯函数）：这一轮试过、此刻没被不可用标记挡着的。被标记的由标记管退避，
// 到期或解除后可以再试；一直避开的话，标记到期时它已被排除，任务只剩「没有能接的执行者」转受阻。
func avoidOf(tried map[string]bool, marked func(workers.Spec) bool) []string {
	var out []string
	for w := range tried {
		if s, err := workers.ParseWorker(w); err == nil && marked(s) {
			continue
		}
		out = append(out, w)
	}
	slices.Sort(out)
	return out
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

// lastAuthorRun 取最近作者轮；审阅轮不覆盖作者重做所需的执行者、机器与选项。
func lastAuthorRun(ctx context.Context, q store.Querier, task string) (*workers.Run, error) {
	var body string
	err := q.QueryRowContext(ctx, `SELECT body FROM task_events WHERE task = ? AND kind = ? AND json_extract(body, '$.why') != ? ORDER BY id DESC LIMIT 1`, task, workers.RunKind, workers.WhyReview).Scan(&body)
	if store.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var r workers.Run
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		return nil, err
	}
	return &r, nil
}
