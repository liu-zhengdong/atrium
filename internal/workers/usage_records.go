package workers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// RunUsage 解析整次日志并按当前档案结算；结果随 exit 保存，此后展示只读 exit。
// 档案写了 usage 时按声明从日志取读数，否则用内置工具的 reader。
func RunUsage(ctx context.Context, q store.Querier, task string, run Run) (Usage, error) {
	t, err := ReadTrace(run.Worker, run.Log)
	if err != nil {
		return Usage{}, err
	}
	w, err := Resolve(ctx, q, run.Worker)
	if err != nil {
		return Usage{}, err
	}
	if w.Rules.Usage != nil {
		raw, err := os.ReadFile(run.Log)
		if os.IsNotExist(err) {
			return Charge(Usage{}, w.Rules), nil
		}
		if err != nil {
			return Usage{}, err
		}
		return Charge(ExtractUsage(string(raw), *w.Rules.Usage), w.Rules), nil
	}
	if w.Spec.Tool == "claude" && run.Why == WhyResume && t.Usage.Cost != nil {
		if err := resumeCost(ctx, q, task, run, &t); err != nil {
			return Usage{}, err
		}
	}
	return Charge(t.Usage, w.Rules), nil
}

// 续接只扣同一会话前一次拉起的工具累计值；不修改历史退出记录。
func resumeCost(ctx context.Context, q store.Querier, task string, run Run, t *Trace) error {
	runs, err := Runs(ctx, q, task, 100)
	if err != nil {
		return err
	}
	for i := len(runs) - 1; i >= 0; i-- {
		prev := runs[i]
		if prev.N >= run.N {
			continue
		}
		old, err := ReadTrace(prev.Worker, prev.Log)
		if err != nil {
			return err
		}
		if t.Session != "" && old.Session == t.Session && old.Usage.Cost != nil {
			n := *t.Usage.Cost - *old.Usage.Cost
			if n > 0 {
				t.Usage.Cost = &n
				return nil
			}
		}
		break
	}
	t.Usage.Cost, t.Usage.Currency, t.Usage.Source = nil, "", ""
	return nil
}

// ExitUsage 读取对应轮号的已保存结果；不自动回填历史（要补算用 Recount）。
func ExitUsage(ctx context.Context, q store.Querier, task string, n int) (Usage, error) {
	var body string
	err := q.QueryRowContext(ctx, `SELECT body FROM task_events WHERE task = ? AND kind = ? AND json_extract(body,'$.n') = ? ORDER BY id DESC LIMIT 1`, task, ExitKind, n).Scan(&body)
	if store.IsNotFound(err) {
		return Usage{}, nil
	}
	if err != nil {
		return Usage{}, err
	}
	var x Exit
	if err := json.Unmarshal([]byte(body), &x); err != nil {
		return Usage{}, err
	}
	return x.Usage, nil
}

// ExitText 给 task show 的退出经历用完整一行，避免正文截断把用量藏掉。
func ExitText(body string) (string, error) {
	var x Exit
	if err := json.Unmarshal([]byte(body), &x); err != nil {
		return "", fmt.Errorf("退出记录坏了：%w", err)
	}
	out := OutText(x.Outcome)
	if out == "" {
		out = "结束"
	}
	return fmt.Sprintf("第 %d 次拉起 %s · %s", x.N, out, x.Usage.String()), nil
}

// RecountKind 是重新结算的经历：body 为 Recounted，留着覆盖前的结果。
const RecountKind = "recount"

// Recounted 是一次拉起重新结算前后的用量。
type Recounted struct {
	N      int   `json:"n"`
	Before Usage `json:"before"`
	After  Usage `json:"after"`
}

// Recount 按当前档案从日志重新结算一件任务每次拉起的用量，覆盖退出记录里的结算结果，每次拉起记一条 recount。
// 给改了档案的用量声明或单价后补算历史用；日志不在就报错停下，不拿空读数覆盖。
func Recount(ctx context.Context, db *store.DB, task, actor string) ([]Recounted, error) {
	if _, err := ledger.Get(ctx, db, task); err != nil {
		return nil, err
	}
	runs, err := Runs(ctx, db, task, 100)
	if err != nil {
		return nil, err
	}
	byN := map[int]Run{}
	for _, r := range runs {
		byN[r.N] = r
	}
	rows, err := db.QueryContext(ctx, `SELECT id, body FROM task_events WHERE task = ? AND kind = ? ORDER BY id LIMIT 100`, task, ExitKind)
	if err != nil {
		return nil, err
	}
	type exit struct {
		id int64
		x  Exit
	}
	var exits []exit
	for rows.Next() {
		var e exit
		var body string
		if err := rows.Scan(&e.id, &body); err != nil {
			rows.Close()
			return nil, err
		}
		if err := json.Unmarshal([]byte(body), &e.x); err != nil {
			rows.Close()
			return nil, fmt.Errorf("任务 %s 的退出记录坏了：%w", task, err)
		}
		exits = append(exits, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(exits) == 0 {
		return nil, api.NotFound("%s 还没有退出记录，没有可重新结算的", task).WithNext("atrium task show " + task)
	}
	var out []Recounted
	for _, e := range exits {
		run, ok := byN[e.x.N]
		if !ok {
			return nil, fmt.Errorf("任务 %s 第 %d 次拉起的记录找不到", task, e.x.N)
		}
		if _, err := os.Stat(run.Log); err != nil {
			return nil, fmt.Errorf("任务 %s 第 %d 次拉起的日志读不了，不能重新结算：%w", task, e.x.N, err)
		}
		u, err := RunUsage(ctx, db, task, run)
		if err != nil {
			return nil, err
		}
		out = append(out, Recounted{N: e.x.N, Before: e.x.Usage, After: u})
	}
	err = db.Tx(ctx, func(tx *sql.Tx) error {
		for i, e := range exits {
			after, _ := json.Marshal(out[i].After)
			if _, err := tx.ExecContext(ctx, `UPDATE task_events SET body = json_set(body, '$.usage', json(?)) WHERE id = ?`, string(after), e.id); err != nil {
				return err
			}
			rec, _ := json.Marshal(out[i])
			if err := ledger.Record(ctx, tx, task, RecountKind, actor, string(rec)); err != nil {
				return err
			}
		}
		return nil
	})
	return out, err
}

// RecountText 给 task show 的重新结算经历一行。
func RecountText(body string) (string, error) {
	var r Recounted
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		return "", fmt.Errorf("重新结算记录坏了：%w", err)
	}
	return fmt.Sprintf("第 %d 次拉起按当前档案重新结算 · %s", r.N, r.After.String()), nil
}
