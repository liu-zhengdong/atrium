package ledger

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

const KindLoopError = "loop_error"

// EachTask 是后台按任务处理的唯一入口，包括以后新增的工作树回收。
// 读取列表只取原始字段；解析登记、检查暂停与执行动作都放在 run 内。
// 出错分两路：Transient 的临时错误（网络瞬断、竞态）先记一轮 loop_retry，
// 下一轮循环自然重做，连续失败次数用尽才转受阻；其余照旧直接转受阻并沿用
// Apply 的处理人通知；已结束任务只记经历。转受阻后不再自动重试，直到该任务
// 有新的状态事件（重新分派任务/放行等）。
// app.NotNow（远程机器这会儿没在领指令）不是失败：不转受阻、不记经历，下一轮再试。
// 标记存在任务经历中，服务重启仍有效，不增加表、内存缓存或重启机制。
func EachTask[T any](ctx context.Context, db *store.DB, operation string, items []T, id func(T) string, run func(T) error) error {
	return app.Each(ctx, db, items, func(item T) error {
		skip, err := loopFailed(ctx, db, id(item), operation)
		if err != nil || skip {
			return err
		}
		return run(item)
	}, func(item T, cause error) error {
		return retryLoopError(ctx, db, operation, id(item), cause)
	})
}

func loopFailed(ctx context.Context, q store.Querier, id, operation string) (bool, error) {
	var skip bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM task_events WHERE task = ? AND kind = ? AND actor = ?
 AND id > (SELECT COALESCE(max(id), 0) FROM task_events WHERE task = ? AND kind IN
 ('created','enqueue','start','exit_ok','exit_fail','gate_pass','review_pass','accept','bounce','land','block','cancel','set','deliver','loop_retry')))`,
		id, KindLoopError, operation, id).Scan(&skip)
	return skip, err
}

// retryLoopError 是单件循环失败的统一入口：临时错误按 RetryDelays 记重试，
// 次数用尽（第 len(RetryDelays)+1 次失败）或非临时错误才转受阻。转受阻的
// 原因里带每轮的失败经过，处理人在 task log 里看得见从第几轮开始、等了多久。
func retryLoopError(ctx context.Context, db *store.DB, operation, id string, cause error) error {
	if !Transient(cause) {
		return taskLoopError(ctx, db, id, operation, cause)
	}
	t, err := Get(ctx, db, id)
	if err != nil || t.Status.Finished() || t.Status == Blocked {
		return err
	}
	n, err := RetryOf(ctx, db, id)
	if err != nil {
		return err
	}
	if n >= len(RetryDelays) {
		return taskLoopError(ctx, db, id, operation,
			fmt.Errorf("重试 %d 轮仍失败：%w", n, cause))
	}
	return Record(ctx, db, id, KindLoopRetry, operation, retryNote(operation, cause, n+1))
}

func taskLoopError(ctx context.Context, db *store.DB, id, operation string, cause error) error {
	t, err := Get(ctx, db, id)
	if err != nil {
		return err
	}
	note := fmt.Sprintf("%s 出错：%v", operation, cause)
	parties := func(ctx context.Context, q store.Querier, id string) (Parties, error) {
		p, err := PartiesOf(ctx, q, id)
		if err == nil {
			return p, nil
		}
		if fatal := app.InfrastructureError(ctx, db, err); fatal != nil {
			return Parties{}, fatal
		}
		// 处理人登记本身坏了，错误交秘书；不改原登记，正常状态操作仍严格校验。
		return Parties{By: org.Secretary, Owner: org.Secretary}, nil
	}
	if !t.Status.Finished() && t.Status != Blocked {
		ev := Event{Kind: Block}
		if _, err := Transition(State{t.Status, t.Stage}, ev); err != nil {
			ev = Event{Kind: Set, To: Blocked}
		}
		if _, err := apply(ctx, db, id, ev, "runtime", note, parties); err != nil {
			return err
		}
	}
	return db.Tx(ctx, func(tx *sql.Tx) error {
		if err := Record(ctx, tx, id, KindLoopError, operation, note); err != nil {
			return err
		}
		if t.Status != Blocked {
			return nil
		}
		// 已受阻任务出现新的坏登记也要把原因交处理人；不会重复转状态。
		p, err := parties(ctx, tx, id)
		if err != nil {
			return err
		}
		return events.EmitTask(ctx, tx, p.Owner, p.By, events.Event{Kind: events.TaskStatus, Task: id, Dept: t.Org, Body: map[string]any{"to": Blocked, "title": t.Title, "note": note, "by": "runtime"}, By: "runtime"})
	})
}
