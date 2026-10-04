package dispatch

import (
	"context"
	"maps"
	"slices"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// view 收集事实并挑执行者（task run --dry-run 与自动分派任务同一份）。
// review 为真时应用 worker_require（审阅轮挑审阅执行者）：不同工具、不同模型、trust 够。
func (d *dispatcher) view(ctx context.Context, t ledger.Task, o Options, exclude map[string]bool, review bool) (PickView, error) {
	risk, tokens := o.Risk, o.Tokens
	db := d.env.DB
	var preferred []string
	if t.Skill != "" {
		s, err := skillOf(ctx, d.env, t.Skill)
		if err != nil {
			return PickView{}, err
		}
		preferred = s.Workers
	}
	catalog, err := workers.Catalog(ctx, db)
	if err != nil {
		return PickView{}, err
	}
	stats, issues, err := workers.StatsIssues(ctx, db)
	if err != nil {
		return PickView{}, app.Global(err)
	}
	ids := make([]string, 0, len(issues))
	for id := range issues {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	if err := ledger.EachTask(ctx, db, "workers.stats", ids, func(id string) string { return id }, func(id string) error { return issues[id] }); err != nil {
		return PickView{}, app.Global(err)
	}
	var facts []Fact
	seen := map[string]bool{}
	iso := isolated(d.env)
	available, err := workers.LoadAvailability(ctx, d.env)
	if err != nil {
		return PickView{}, app.Global(err)
	}
	exclude = maps.Clone(exclude)
	for i, id := range append(slices.Clone(preferred), catalog...) {
		r, err := workers.Resolve(ctx, db, id)
		if err != nil {
			if !isAPI(err) {
				return PickView{}, err
			}
			if !seen[id] {
				facts = append(facts, Fact{ID: id, Problem: err.Error()})
				seen[id] = true
			}
			continue
		}
		if seen[r.ID] {
			continue
		}
		seen[r.ID] = true
		f := Fact{ID: r.ID, Tool: r.Spec.Tool, Model: r.Spec.Model, Account: r.Account(), Trust: r.Rules.EffectiveTrust(),
			MaxRisk: r.Rules.EffectiveMaxRisk(), Refusal: r.Rules.Refusal(risk, true),
			Exclusive: r.Adapter.Exclusive, Stat: workers.Count(stats[workers.Combo(r.ID)]), Fails: workers.Fails(stats[workers.Combo(r.ID)], ShakyWindow)}
		f.Cost = r.Rules
		f.Prefer = r.Rules.Prefer
		if !review && available.Marked(r.Spec) {
			delete(exclude, r.ID)
		}
		if _, builtin := workers.Builtin(r.Spec.Tool); iso && builtin {
			f.Unavailable = "隔离实例（ATRIUM_DATA 不是缺省目录）不自动挑内置工具"
		} else {
			need, err := hostNeed(ctx, db, r.Spec, t)
			if err != nil {
				return PickView{}, err
			}
			// 满载只影响何时拉起，不影响工具与任务能否匹配。
			need.Urgent = true
			if review {
				need.Task = t.ID
			}
			choice, err := pickHost(ctx, d.env, need, o.Host)
			if err != nil {
				return PickView{}, err
			}
			if choice.Host != "" {
				r, err = workers.ResolveExecution(ctx, d.env, r, choice.Host)
				if err != nil {
					return PickView{}, err
				}
				sp, why := available.CheckResolved(r, choice.Host, tokens)
				f.Quota = &sp
				if why != "" {
					f.Waiting = why // 不可用标记会到期或被解除，等它
				}
			}
			if choice.Kind == "queue" {
				f.Waiting = choice.Reason
			} else if choice.Kind != "run" {
				f.Unavailable = choice.Reason
			}
		}
		if i < len(preferred) {
			f.Preferred = i + 1
		}
		if err := r.Check(); err != nil {
			f.Problem = err.Error()
		}
		facts = append(facts, f)
	}
	if review {
		req, err := requirement(ctx, db, t.ID)
		if err != nil {
			return PickView{}, err
		}
		for i := range facts {
			f := &facts[i]
			if why := reviewRefusal(req, f.ID, f.Tool, f.Model, f.Trust); why != "" && f.Refusal == "" {
				f.Refusal = why
			}
			f.Recused = req.Recused(f.ID)
		}
	}
	busy, err := busyTools(ctx, db)
	if err != nil {
		return PickView{}, err
	}
	return Pick(PickInput{Tokens: tokens, Risk: risk, Priority: t.Priority, Facts: facts, Busy: busy, Exclude: exclude}), nil
}
