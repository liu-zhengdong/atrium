package gates

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
	"gopkg.in/yaml.v3"
)

// 与 dispatch 的约定（都记在任务经历 task_events 里，取最近一条）：
//
//	worktree        dispatch 拉起执行者时记：{"dir": "<工作树绝对路径>"}；关卡在这里查事实
//	risk            task run --risk 记：high / medium / low（没记按 low）
//	result          执行者退出时记它最后的回复原文；审阅结论从这里读
//	worker_require  gates 建审阅任务时记（Requirement 的 JSON）；dispatch 挑执行者时按它排除
const (
	KindWorktree = "worktree"
	KindRisk     = "risk"
	KindResult   = "result"
	KindRequire  = "worker_require"
	KindReviewOf = "review_of" // 审阅任务上：被审的原任务 tN
	KindReviewer = "reviewer"  // 原任务上：这一轮的审阅任务 tN
	KindGate     = "gate"      // 关卡结论（Verdict JSON）
	KindReview   = "review"    // 审阅结论
	KindMerge    = "merge"     // 合入队列的经过：冲突文件、检查没过的摘要、跳过检查
	// KindMergeCommit 是合入后 merge 记的 {"pr","commit"}；release 据此等含它的版本。
	KindMergeCommit = "merge_commit"
)

// Last 取一件任务某类经历的最近一条正文；没有时 found=false。
func Last(ctx context.Context, q store.Querier, task, kind string) (body string, found bool, err error) {
	err = q.QueryRowContext(ctx, `SELECT body FROM task_events WHERE task = ? AND kind = ? ORDER BY id DESC LIMIT 1`,
		task, kind).Scan(&body)
	if store.IsNotFound(err) {
		return "", false, nil
	}
	return body, err == nil, err
}

// Workspace 取执行者的工作树目录。
func Workspace(ctx context.Context, q store.Querier, task string) (string, error) {
	body, ok, err := Last(ctx, q, task, KindWorktree)
	if err != nil || !ok {
		return "", firstErr(err, fmt.Errorf("%s 没有工作树登记（经历里没有 %s）", task, KindWorktree))
	}
	var w struct {
		Dir string `json:"dir"`
	}
	if err := json.Unmarshal([]byte(body), &w); err != nil || w.Dir == "" {
		return "", fmt.Errorf("%s 的工作树登记不是 {\"dir\":…}：%s", task, body)
	}
	return w.Dir, nil
}

// Risk 取任务风险；没记按 low。
func Risk(ctx context.Context, q store.Querier, task string) (string, error) {
	body, ok, err := Last(ctx, q, task, KindRisk)
	if err != nil || !ok {
		return "low", err
	}
	return strings.TrimSpace(body), nil
}

func firstErr(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

// Profile 是关卡要的档案事实：工具、模型、信任、checks。
type Profile struct {
	Name   string
	Tool   string
	Model  string
	Trust  string
	Checks []string // nil 表示档案没写，按 DefaultChecks
}

// LoadProfile 读 worker_profiles 里这一个档案的顶层字段（tool、model、trust、checks）。
// 三层叠加归 workers 包；第三波接上 workers 的解析后换掉这里。
func LoadProfile(ctx context.Context, q store.Querier, name string) (Profile, error) {
	var spec string
	err := q.QueryRowContext(ctx, `SELECT spec FROM worker_profiles WHERE name = ?`, name).Scan(&spec)
	if store.IsNotFound(err) {
		// dispatch 记在任务上的是执行者标识（工具+模型[:强度]），档案按 workers 三层叠加解析。
		// 第三波把上面按名字直读的旧写法（本包测试在用）统一到这里。
		r, err := workers.Resolve(ctx, q, name)
		if err != nil {
			return Profile{}, err
		}
		return Profile{Name: r.ID, Tool: r.Spec.Tool, Model: r.Spec.Model, Trust: r.Rules.EffectiveTrust(), Checks: r.Rules.Checks}, nil
	}
	if err != nil {
		return Profile{}, err
	}
	var y struct {
		Tool   string    `yaml:"tool"`
		Model  string    `yaml:"model"`
		Trust  string    `yaml:"trust"`
		Checks *[]string `yaml:"checks"`
	}
	if err := yaml.Unmarshal([]byte(spec), &y); err != nil {
		return Profile{}, fmt.Errorf("执行者档案 %s 不是合法 YAML：%w", name, err)
	}
	p := Profile{Name: name, Tool: y.Tool, Model: y.Model, Trust: y.Trust}
	if p.Tool == "" {
		p.Tool = name
	}
	if y.Checks != nil {
		p.Checks = append([]string{}, *y.Checks...)
	}
	return p, nil
}

// Requeue 给已转成 queued 的任务写派活队列行。ledger.Apply(Bounce/Enqueue) 不写 queue 表，
// 交回与建审阅任务之后由这里补上；第三波换成 dispatch 的入队函数。
func Requeue(ctx context.Context, db *store.DB, id string) error {
	return db.Tx(ctx, func(tx *sql.Tx) error {
		t, err := ledger.Get(ctx, tx, id)
		if err != nil {
			return err
		}
		if t.Status != ledger.Queued {
			return nil
		}
		_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO queue (task, priority, enqueued_at) VALUES (?, ?, ?)`,
			id, t.Priority.Rank(), store.Now())
		return err
	})
}

// Bounce 交回原执行者（同工作树同分支重派）：记原因、按次数转 queued 或 blocked，queued 时补队列行。
func Bounce(ctx context.Context, db *store.DB, id, actor, reason string) (ledger.Task, error) {
	t, err := ledger.Apply(ctx, db, id, ledger.Event{Kind: ledger.Bounce}, actor, reason)
	if err != nil {
		return t, err
	}
	return t, Requeue(ctx, db, id)
}
