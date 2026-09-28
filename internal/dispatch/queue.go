package dispatch

import (
	"context"
	"database/sql"
	"encoding/json"
	"regexp"
	"slices"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// Options 是 task run 的选项；也是队列里一行的内容。
type Options struct {
	Worker  string   `json:"worker,omitempty"` // 空表示自动挑
	Risk    string   `json:"risk,omitempty"`   // 缺省 low
	Host    string   `json:"host,omitempty"`   // 空表示自动挑
	Secrets []string `json:"secrets,omitempty"`
	Avoid   []string `json:"avoid,omitempty"` // 自动挑时避开的执行者（watch 换人时给）
}

var secretNameRE = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,63}$`)

// check 核对选项（纯的部分）并补缺省。
func (o *Options) check() error {
	if o.Risk == "" {
		o.Risk = "low"
	}
	if workers.RiskLevel(o.Risk) < 0 {
		return api.Usage("--risk: 只能是 %s，收到 %q", strings.Join(workers.Risks, "、"), o.Risk)
	}
	if o.Host != "" && !api.IsRef(o.Host, "h") {
		return api.Usage("--host: 应为 hN，收到 %q", o.Host)
	}
	for _, s := range o.Secrets {
		if !secretNameRE.MatchString(s) || strings.HasPrefix(s, "ATRIUM_") {
			return api.Usage("--secret: 凭据名是大写环境变量名（不以 ATRIUM_ 开头），收到 %q", s)
		}
	}
	return nil
}

// item 是派活队列里的一件：状态 queued 的任务，带着入队选项（交回的任务没有队列行，沿用上次拉起的执行者与选项）。
type item struct {
	Task ledger.Task
	Opts Options
	Row  bool // 有队列行
}

// priorityOrder 是队列排序：优先级（紧急、修复、普通、闲时）、入队先后。
const priorityOrder = `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'fix' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`

const maxQueue = 500

// queued 按派活顺序列出队列里的任务。
func queued(ctx context.Context, q store.Querier) ([]item, error) {
	rows, err := q.QueryContext(ctx, `SELECT t.id, q.opts FROM tasks t LEFT JOIN queue q ON q.task = t.id
		WHERE t.status = 'queued' ORDER BY `+priorityOrder+`, COALESCE(q.enqueued_at, t.updated_at), t.id LIMIT ?`, maxQueue)
	if err != nil {
		return nil, err
	}
	type raw struct {
		id   string
		opts sql.NullString
	}
	var list []raw
	for rows.Next() {
		var r raw
		if err := rows.Scan(&r.id, &r.opts); err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]item, 0, len(list))
	for _, r := range list {
		t, err := ledger.Get(ctx, q, r.id)
		if err != nil {
			return nil, err
		}
		it := item{Task: t, Row: r.opts.Valid}
		if r.opts.Valid {
			if err := json.Unmarshal([]byte(r.opts.String), &it.Opts); err != nil {
				return nil, err
			}
		} else if last, err := workers.LastRun(ctx, q, r.id); err != nil {
			return nil, err
		} else if last != nil {
			// 交回原执行者：同一执行者、同样的风险与凭据。
			it.Opts = Options{Worker: last.Worker, Risk: last.Risk, Secrets: last.Secrets}
		}
		if it.Opts.Risk == "" {
			it.Opts.Risk = "low"
		}
		out = append(out, it)
	}
	return out, nil
}

// Position 是任务在队列里排第几（1 起）；不在队列返回 0。
func Position(ctx context.Context, q store.Querier, id string) (int, error) {
	list, err := queued(ctx, q)
	if err != nil {
		return 0, err
	}
	for i, it := range list {
		if it.Task.ID == id {
			return i + 1, nil
		}
	}
	return 0, nil
}

func dropRow(ctx context.Context, q store.Querier, id string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM queue WHERE task = ?`, id)
	return err
}

// Enqueue 是 task run：核对选项、进派活队列。写死的执行者当场核对档案能不能接，免得排到时才报错。
func Enqueue(ctx context.Context, env *app.Env, id string, o Options, actor string) (ledger.Task, error) {
	if err := o.check(); err != nil {
		return ledger.Task{}, err
	}
	db := env.DB
	t, err := ledger.Get(ctx, db, id)
	if err != nil {
		return t, err
	}
	deps, err := ledger.Deps(ctx, db, id)
	if err != nil {
		return t, err
	}
	if ready, waiting := ledger.Ready(t.Status, deps); !ready && len(waiting) > 0 {
		return t, api.Conflict("%s 还在等依赖 %s 完成", id, strings.Join(waiting, "、")).WithNext("atrium task wait " + waiting[0])
	}
	if o.Worker != "" {
		r, err := workers.Resolve(ctx, db, o.Worker)
		if err != nil {
			return t, err
		}
		if err := r.Check(); err != nil {
			return t, err
		}
		if why := r.Rules.Refusal(o.Risk); why != "" {
			return t, api.Conflict("%s 接不了：%s", r.ID, why).WithNext("atrium task run " + id + " --dry-run --risk " + o.Risk)
		}
		o.Worker = r.ID
	}
	raw, _ := json.Marshal(o)
	if err := db.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO queue (task, enqueued_at, opts, by) VALUES (?, ?, ?, ?)
			ON CONFLICT (task) DO UPDATE SET enqueued_at = excluded.enqueued_at, opts = excluded.opts, by = excluded.by`,
			id, store.Now(), string(raw), actor)
		return err
	}); err != nil {
		return t, err
	}
	t, err = ledger.Apply(ctx, db, id, ledger.Event{Kind: ledger.Enqueue}, actor, summary(o))
	if err != nil {
		if e := dropRow(ctx, db, id); e != nil {
			return t, e
		}
		return t, err
	}
	return t, nil
}

func summary(o Options) string {
	var parts []string
	if o.Worker != "" {
		parts = append(parts, "执行者 "+o.Worker)
	}
	parts = append(parts, "risk "+o.Risk)
	if o.Host != "" {
		parts = append(parts, "机器 "+o.Host)
	}
	if len(o.Secrets) > 0 {
		parts = append(parts, "凭据 "+strings.Join(o.Secrets, "、"))
	}
	return strings.Join(parts, "，")
}

// union 合并两个名单（保持先后、去重）。
func union(a, b []string) []string {
	out := slices.Clone(a)
	for _, v := range b {
		if !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}
