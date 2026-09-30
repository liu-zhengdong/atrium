package workers

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// RunUsage 解析整次日志并按当前档案结算；结果随 exit 保存，此后展示只读 exit。
func RunUsage(ctx context.Context, q store.Querier, task string, run Run) (Usage, error) {
	t, err := ReadTrace(run.Worker, run.Log)
	if err != nil {
		return Usage{}, err
	}
	w, err := Resolve(ctx, q, run.Worker)
	if err != nil {
		return Usage{}, err
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

// ExitUsage 读取对应轮号的已保存结果；不回填历史日志。
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
func ExitText(body string) string {
	var x Exit
	if json.Unmarshal([]byte(body), &x) != nil {
		return body
	}
	out := OutText(x.Outcome)
	if out == "" {
		out = "结束"
	}
	return fmt.Sprintf("第 %d 次拉起 %s · %s", x.N, out, x.Usage.String())
}
