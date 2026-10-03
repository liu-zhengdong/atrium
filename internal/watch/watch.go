// Package watch：等待对象与处理时限。一张表（rules.go 的 Rules）、一个巡检循环（一分钟一轮，全局暂停时不做），
// 到期统一发 events.Overdue；每轮顺带数各部门与全局的上限用量，刚到或超了发 events.LimitFull。
// 「在等谁」的判定 HolderOf 是纯函数，top、statusline、task show、网页共用。
//
// 接入（别的包调）：
//   - dispatch、merge 拉起执行者或检查后，在同一事务里 watch.Track(ctx, tx, 任务, Proc{…}) 登记进程；
//   - dispatch 在 Routes 里 watch.Use(Hooks{Requeue: …})：卡住、额度用尽或思考耗尽时重新入队（可换人、标记额度）；
//   - workers 在 Routes 里 watch.Use(Hooks{Signal: …})：从日志尾部读出思考耗尽、额度用尽与收尾。
//
// watch 自己改状态（ExitOK、ExitFail、Block）一律先 ledger.Apply 再结束进程树；拉起者在进程退出后
// 再 Apply 会得到 conflict（任务已不在 running），按「已由 watch 收尾」忽略即可。
package watch

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/org/leaders"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Module 是本包接入点：巡检循环、top 命令与只读接口。
func Module() app.Module {
	return app.Module{Name: "watch", Commands: Commands, Routes: Routes, Run: Run}
}

// Why 是交给分派任务重新入队的原因。
type Why struct {
	Reason string `json:"reason"`
	Signal Signal `json:"signal,omitempty"`
	Worker string `json:"worker,omitempty"`
}

// Hooks 是 watch 要别的包提供的判定与动作；没接上的留 nil。
type Hooks struct {
	// Signal（workers）：按执行者组合从日志尾部读信号。
	Signal func(worker string, tail []byte) Signal
	// Requeue（dispatch）：任务已被 watch 转为 failed，重新入队；可据 Why 换人、标记额度用尽。
	Requeue func(ctx context.Context, task string, why Why) error
}

var hooks struct {
	sync.Mutex
	h Hooks
}

// Use 接上钩子：只覆盖给了的字段。
func Use(h Hooks) {
	hooks.Lock()
	defer hooks.Unlock()
	if h.Signal != nil {
		hooks.h.Signal = h.Signal
	}
	if h.Requeue != nil {
		hooks.h.Requeue = h.Requeue
	}
}

func current() Hooks {
	hooks.Lock()
	defer hooks.Unlock()
	return hooks.h
}

// Track 登记一个刚拉起的进程（记进任务经历，kind "proc"）；服务重启后 watch 据此继续跟进。
func Track(ctx context.Context, q store.Querier, task string, p Proc) error {
	if p.At == 0 {
		p.At = store.Now()
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	return ledger.Record(ctx, q, task, "proc", "runtime", string(raw))
}

// latestProc 读任务最近登记的进程；没有为 nil。
func latestProc(ctx context.Context, q store.Querier, task string) (*Proc, error) {
	var body string
	err := q.QueryRowContext(ctx, `SELECT body FROM task_events WHERE task = ? AND kind = 'proc' ORDER BY id DESC LIMIT 1`, task).Scan(&body)
	if store.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p Proc
	if err := json.Unmarshal([]byte(body), &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// startStucks 数这件任务因启动卡住被重试过几次。
func startStucks(ctx context.Context, q store.Querier, task string) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT count(*) FROM task_events WHERE task = ? AND kind = 'watch' AND body LIKE ?`,
		task, `%"role":"`+string(RoleWorkerStart)+`"%`).Scan(&n)
	return n, err
}

// procFor：当前阶段对应的进程（执行者对应 running/""，检查对应 merge_queue）。
func procFor(t ledger.Task, p *Proc) *Proc {
	if p == nil || t.Status != ledger.Running {
		return nil
	}
	if (t.Stage == ledger.StageNone && p.Role == "worker") || (t.Stage == ledger.StageMerge && p.Role == "check") {
		return p
	}
	return nil
}

// FactsOf 从账本、组织与巡检内存里取一件任务的事实。
func FactsOf(ctx context.Context, q store.Querier, t ledger.Task) (Facts, error) {
	f := Facts{Task: t}
	var err error
	if f.Owner, err = org.Recipient(ctx, q, t.Org); err != nil {
		return f, err
	}
	// 负责人的等待归实际处理人；验收仍归部门设置的验收人。
	if t.Stage != ledger.StageAccept {
		p, err := ledger.PartiesOf(ctx, q, t.ID)
		if err != nil {
			return f, err
		}
		if api.IsRef(p.Owner, "a") {
			f.Owner = p.Owner
		}
	}
	if t.Stage == ledger.StageAccept {
		if f.Acceptor, _, err = org.Acceptor(ctx, q, t.Org); err != nil {
			return f, err
		}
	}
	if t.Status == ledger.Todo || t.Status == ledger.Queued {
		if f.Deps, err = ledger.Deps(ctx, q, t.ID); err != nil {
			return f, err
		}
	}
	if t.Status == ledger.Todo {
		if f.DepEnded, err = depEnded(ctx, q, f.Deps); err != nil {
			return f, err
		}
		if f.OpenChildren, f.Children, err = ledger.Children(ctx, q, t.ID); err != nil {
			return f, err
		}
		if f.Children > 0 && f.OpenChildren == 0 {
			if f.ChildEnded, err = childEnded(ctx, q, t.ID); err != nil {
				return f, err
			}
		}
	}
	p, err := latestProc(ctx, q, t.ID)
	if err != nil {
		return f, err
	}
	if f.Proc = procFor(t, p); f.Proc != nil {
		f.ProgressAt = progressOf(t.ID, f.Proc.PID)
	}
	return f, nil
}

// depEnded 取已结束的依赖各自结束的时刻（至多 50 个依赖，逐个读）。
func depEnded(ctx context.Context, q store.Querier, deps []ledger.DepState) (map[string]int64, error) {
	out := map[string]int64{}
	for _, d := range deps {
		if !d.Status.Finished() {
			continue
		}
		dt, err := ledger.Get(ctx, q, d.ID)
		if err != nil {
			return nil, err
		}
		if dt.FinishedAt != nil {
			out[d.ID] = *dt.FinishedAt
		}
	}
	return out, nil
}

// childEnded 取子任务里最晚结束的时刻（看最近建的 500 个）。
func childEnded(ctx context.Context, q store.Querier, id string) (int64, error) {
	kids, err := ledger.List(ctx, q, ledger.Filter{Parent: id, Status: []ledger.Status{ledger.Done, ledger.Failed, ledger.Cancelled}, Limit: 500})
	if err != nil {
		return 0, err
	}
	var at int64
	for _, k := range kids {
		if k.FinishedAt != nil {
			at = max(at, *k.FinishedAt)
		}
	}
	return at, nil
}

// upOf 是实际等待的负责人的上一层，复用负责人上报的组织路由；
// 处理人已是秘书时没有更上一层，仍是秘书自己：60 分钟那一轮再提醒一次。
func upOf(ctx context.Context, q store.Querier, who, dept string) (string, error) {
	ps, err := org.Parents(ctx, q)
	if err != nil {
		return "", err
	}
	lm, err := org.LeaderMap(ctx, q)
	if err != nil {
		return "", err
	}
	return leaders.Upstream(ps, lm, who, dept), nil
}
