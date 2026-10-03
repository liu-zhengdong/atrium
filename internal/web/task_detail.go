package web

import (
	"context"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/watch"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// TaskDetail 是任务抽屉。
type TaskDetail struct {
	PartyLabels   map[string]string  `json:"party_labels"`
	HistoryLabels map[string]string  `json:"history_labels"`
	Parties       ledger.Parties     `json:"parties"`
	History       []ledger.TaskEvent `json:"history"` // 最近 50 条，正文原样
	UsageText     string             `json:"usage_text,omitempty"`
	Task          ledger.Task        `json:"task"`
	DeptName      string             `json:"dept_name"`
	Steps         []string           `json:"steps"`
	Step          int                `json:"step"`
	State         string             `json:"state"`
	Holder        string             `json:"holder"`
	Trace         *workers.Trace     `json:"trace"`   // 最近一次拉起的经过（与 task log 同一份解析）；还没拉起过为空
	Live          bool               `json:"live"`    // 执行者正在干（执行这一步）
	RunAt         int64              `json:"run_at"`  // 最近一次拉起的时刻
	Parent        *Row               `json:"parent"`  // 挂在谁下面；没有为空
	Kids          []Row              `json:"kids"`    // 直接的子任务（按建立先后）
	Waits         []Row              `json:"waits"`   // 它要等的（依赖，含已结束的）
	Waiters       []Row              `json:"waiters"` // 在等它的
	// 由哪条定时任务生成（sN），它交出的或它选自的选项单（cN）；没有为空。
	Schedule string `json:"schedule,omitempty"`
	Choice   string `json:"choice,omitempty"`
	// 带来源的：任务分派人（记录人）的名字，是负责人时给他的负责人抽屉地址「oN/aN」（负责的第一个部门/身份）。
	ByName string `json:"by_name,omitempty"`
	ByLead string `json:"by_lead,omitempty"`
}

func loadTask(ctx context.Context, q store.Querier, id string) (TaskDetail, error) {
	t, err := ledger.Get(ctx, q, id)
	if err != nil {
		return TaskDetail{}, err
	}
	h, err := holderOf(ctx, q, t)
	if err != nil {
		return TaskDetail{}, err
	}
	names, err := loadNames(ctx, q)
	if err != nil {
		return TaskDetail{}, err
	}
	out := TaskDetail{Task: t, Steps: stepsOf(t), Step: step(t), State: state(t, h), Holder: holderText(t, h, names)}
	if out.Parties, err = ledger.PartiesOf(ctx, q, id); err != nil {
		return out, err
	}
	if out.History, err = ledger.History(ctx, q, id, 50); err != nil {
		return out, err
	}
	out.PartyLabels = map[string]string{"by": identityText(out.Parties.By, names), "owner": identityText(out.Parties.Owner, names)}
	out.HistoryLabels = map[string]string{}
	for _, e := range out.History {
		out.HistoryLabels[e.Actor] = identityText(e.Actor, names)
	}
	if err := relations(ctx, q, &out); err != nil {
		return out, err
	}
	if out.Schedule, err = agenda.ScheduleOf(ctx, q, id); err != nil {
		return out, err
	}
	if out.Choice, err = agenda.ChoiceOf(ctx, q, id); err != nil {
		return out, err
	}
	if t.Source != "" {
		if err := recorder(ctx, q, &out, names); err != nil {
			return out, err
		}
	}
	if t.Org != "" {
		if err := q.QueryRowContext(ctx, `SELECT name FROM departments WHERE id = ?`, t.Org).Scan(&out.DeptName); err != nil {
			return out, err
		}
	}
	if out.State == "bad" {
		reason, err := lastReason(ctx, q, id)
		if err != nil {
			return out, err
		}
		if reason != "" {
			out.Holder = reason
		}
	}
	run, err := workers.LastRun(ctx, q, id)
	if err != nil || run == nil {
		return out, err
	}
	tr, err := workers.ReadTrace(run.Worker, run.Log)
	if err != nil {
		return out, err
	}
	out.Trace, out.RunAt, out.Live = &tr, run.At, t.Status == ledger.Running && t.Stage == ledger.StageNone
	err = taskUsage(ctx, q, id, *run, &out)
	return out, err
}

// recorder 填来源一行的记录人：任务分派人的名字（loadNames），负责人另给他的负责人抽屉地址。
func recorder(ctx context.Context, q store.Querier, d *TaskDetail, names map[string]string) error {
	p := d.Parties
	if p.By == "" {
		return nil
	}
	d.ByName = identityText(p.By, names)
	leaders, err := org.LeaderMap(ctx, q)
	if err != nil {
		return err
	}
	if led := org.Led(leaders, p.By); len(led) > 0 {
		d.ByLead = led[0] + "/" + p.By
	}
	return nil
}

// relations 填任务抽屉里的上级、子任务、它要等的、在等它的。
func relations(ctx context.Context, q store.Querier, d *TaskDetail) error {
	ix, err := loadOrg(ctx, q)
	if err != nil {
		return err
	}
	t := d.Task
	row := func(id string) (Row, error) {
		x, err := ledger.Get(ctx, q, id)
		if err != nil {
			return Row{}, err
		}
		return looseRow(ctx, q, x, ix)
	}
	if t.Parent != "" {
		p, err := row(t.Parent)
		if err != nil {
			return err
		}
		d.Parent = &p
	}
	sub, err := ledger.Subtree(ctx, q, t.ID)
	if err != nil {
		return err
	}
	d.Kids = []Row{}
	kids := countKids(sub)
	for _, k := range sub[1:] {
		if k.Parent != t.ID {
			continue
		}
		r, err := rowOf(ctx, q, k, ix, kids[k.ID])
		if err != nil {
			return err
		}
		d.Kids = append(d.Kids, r)
	}
	deps, err := ledger.Deps(ctx, q, t.ID)
	if err != nil {
		return err
	}
	d.Waits = []Row{}
	for _, dep := range deps {
		r, err := row(dep.ID)
		if err != nil {
			return err
		}
		d.Waits = append(d.Waits, r)
	}
	// 反向依赖 ledger 还没有读函数，先在这里查（只读、有界）。
	rows, err := q.QueryContext(ctx, `SELECT d.task FROM task_deps d JOIN tasks t ON t.id = d.task
		WHERE d.depends_on = ? ORDER BY t.created_at LIMIT 50`, t.ID)
	if err != nil {
		return err
	}
	ids, err := scanIDs(rows)
	if err != nil {
		return err
	}
	d.Waiters = []Row{}
	for _, id := range ids {
		r, err := row(id)
		if err != nil {
			return err
		}
		d.Waiters = append(d.Waiters, r)
	}
	return nil
}

// holderOf 是任务详情的等待对象：取齐事实交给 watch.HolderOf（与 top、statusline 同一份判定）。
func holderOf(ctx context.Context, q store.Querier, t ledger.Task) (watch.Holder, error) {
	f := watch.Facts{Task: t}
	var err error
	if f.Owner, err = org.Recipient(ctx, q, t.Org); err != nil {
		return watch.Holder{}, err
	}
	if f.Deps, err = ledger.Deps(ctx, q, t.ID); err != nil {
		return watch.Holder{}, err
	}
	if f.OpenChildren, f.Children, err = ledger.Children(ctx, q, t.ID); err != nil {
		return watch.Holder{}, err
	}
	return watch.HolderOf(f), nil
}

// holderText 是「现在在等谁」：没结束的按等待对象说，结束了的按结果说。
// 要负责人、秘书动手的写上是谁（names 里的名字）；执行者是谁、在哪台机器，抽屉下面「执行者」一行写着，这里不重复；
// 等你的、等运行时的，话里已说明。
func holderText(t ledger.Task, h watch.Holder, names map[string]string) string {
	if t.Status.Finished() && t.Status != ledger.Failed {
		return finishedText(t)
	}
	switch h.Kind {
	case "leader", "secretary":
		return identityText(h.Who, names) + "：" + h.Text
	case "worker":
		return "执行者在做"
	}
	return h.Text
}
