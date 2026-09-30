package dispatch

import (
	"context"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
	"slices"
)

// view 收集事实并挑执行者（task run --dry-run 与自动派活同一份）。
func (d *dispatcher) view(ctx context.Context, t ledger.Task, risk string, exclude map[string]bool) (PickView, error) {
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
	loggedOut, err := localLoggedOut(ctx, db)
	if err != nil {
		return PickView{}, err
	}
	marks, err := workers.Marks(ctx, db, store.Now())
	if err != nil {
		return PickView{}, err
	}
	stats, err := workers.Stats(ctx, db)
	if err != nil {
		return PickView{}, err
	}
	var facts []Fact
	seen := map[string]bool{}
	iso := isolated(d.env)
	for i, id := range append(slices.Clone(preferred), catalog...) {
		r, err := workers.Resolve(ctx, db, id)
		if err != nil {
			if !isAPI(err) {
				return PickView{}, err
			}
			if !seen[id] {
				facts = append(facts, Fact{ID: id, Problem: err.Error(), Installed: true})
				seen[id] = true
			}
			continue
		}
		if seen[r.ID] {
			continue
		}
		seen[r.ID] = true
		f := Fact{ID: r.ID, Tool: r.Spec.Tool, Model: r.Spec.Model, Account: accountOf(r.Spec.Tool), Trust: r.Rules.EffectiveTrust(),
			MaxRisk: r.Rules.EffectiveMaxRisk(), Refusal: r.Rules.Refusal(risk, true), Installed: workers.Installed(r.Adapter),
			Exclusive: r.Adapter.Exclusive, Stat: workers.Count(stats[workers.Combo(r.ID)]), Fails: workers.Fails(stats[workers.Combo(r.ID)], ShakyWindow)}
		if _, builtin := workers.Builtin(r.Spec.Tool); iso && builtin {
			f.Unavailable = "隔离实例（ATRIUM_DATA 不是缺省目录）不自动挑内置工具"
		} else if m, ok := workers.Blocked(marks, r.Spec.Tool, r.Spec.Model, LocalHost); ok {
			f.Unavailable = "本机不可用：" + m.Text()
		} else if loggedOut[r.Spec.Tool] {
			f.Unavailable = "没登录：本机的 " + r.Spec.Tool + " 没登录（atrium host ls " + LocalHost + "）"
		}
		if i < len(preferred) {
			f.Preferred = i + 1
		}
		if err := r.Check(); err != nil {
			f.Problem = err.Error()
		}
		facts = append(facts, f)
	}
	req, err := requirement(ctx, db, t.ID)
	if err != nil {
		return PickView{}, err
	}
	for i := range facts {
		if why := req.refusal(facts[i]); why != "" && facts[i].Refusal == "" {
			facts[i].Refusal = why
		}
	}
	sp, err := spares(ctx, d.env)
	if err != nil {
		return PickView{}, err
	}
	busy, err := busyTools(ctx, db)
	if err != nil {
		return PickView{}, err
	}
	return Pick(PickInput{Risk: risk, Priority: t.Priority, Facts: facts, Spares: sp, Busy: busy, Exclude: exclude}), nil
}
