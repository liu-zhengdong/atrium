package watch

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// TaskRow 是一件没结束的任务与它的当前等待对象。
type TaskRow struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Org     string `json:"org,omitempty"`
	Status  string `json:"status"`
	Stage   string `json:"stage,omitempty"`
	Worker  string `json:"worker,omitempty"`
	Host    string `json:"host,omitempty"`
	Holder  Holder `json:"holder"`
	Overdue int    `json:"overdue"` // 到期几轮（Level）
}

// DeptRow 是一个部门在跑与卡住（受阻、失败）的任务数。
type DeptRow struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Running int    `json:"running"`
	Stuck   int    `json:"stuck"`
}

// SecretaryView 是秘书这一侧：在不在听、积压几条、有没有事件超过 3 分钟没人取（状态栏标红）。
type SecretaryView struct {
	Listening *events.Listener `json:"listening"`
	Pending   int              `json:"pending"`
	Unheard   int64            `json:"unheard_since,omitempty"`
	Red       bool             `json:"red"`
}

// View 是 top 与 statusline 共用的全景。
type View struct {
	Names     map[string]string `json:"-"` // 人读呈现名册；不进入机器输出
	Owners    map[string]string `json:"-"` // 仅 top 人读父任务行加载；不替代等待对象
	At        int64             `json:"at"`
	Tasks     []TaskRow         `json:"tasks"`
	Choices   int               `json:"choices"` // 等你拍板的选项单
	Depts     []DeptRow         `json:"depts"`
	Queued    int               `json:"queued"`
	Drafts    int               `json:"drafts"` // 草稿只给数：不计时、不等人
	Goals     ledger.Goals      `json:"goals"`  // 三个目标的数：纠正、认可、复发
	Secretary SecretaryView     `json:"secretary"`
	Paused    []string          `json:"paused"`
}

// Working 是执行者在干活的任务。
func (v View) Working() []TaskRow { return v.filter("worker") }

func (v View) filter(kind string) []TaskRow {
	var out []TaskRow
	for _, t := range v.Tasks {
		if t.Holder.Kind == kind {
			out = append(out, t)
		}
	}
	return out
}

// BuildView 读账本、组织与事件，算出全景。
func BuildView(ctx context.Context, env *app.Env) (View, error) {
	db := env.DB
	now := store.Now()
	v := View{At: now, Tasks: []TaskRow{}, Depts: []DeptRow{}, Paused: []string{}}
	tasks, err := ledger.List(ctx, db, ledger.Filter{Status: []ledger.Status{ledger.Todo, ledger.Queued, ledger.Running,
		ledger.Blocked, ledger.Failed}, Limit: 500})
	if err != nil {
		return v, err
	}
	depts := map[string]*DeptRow{}
	for _, t := range tasks {
		f, err := FactsOf(ctx, db, t)
		if err != nil {
			return v, err
		}
		h := HolderOf(f)
		v.Tasks = append(v.Tasks, TaskRow{ID: t.ID, Title: t.Title, Org: t.Org, Status: string(t.Status), Stage: string(t.Stage),
			Worker: t.Worker, Host: t.Host, Holder: h, Overdue: Level(h, now)})
		if t.Status == ledger.Queued {
			v.Queued++
		}
		if t.Org == "" {
			continue
		}
		d := depts[t.Org]
		if d == nil {
			d = &DeptRow{ID: t.Org}
			depts[t.Org] = d
		}
		switch t.Status {
		case ledger.Running:
			d.Running++
		case ledger.Blocked, ledger.Failed:
			d.Stuck++
		}
	}
	for _, d := range depts {
		if err := db.QueryRowContext(ctx, `SELECT name FROM departments WHERE id = ?`, d.ID).Scan(&d.Name); err != nil {
			return v, err
		}
		v.Depts = append(v.Depts, *d)
	}
	sort.Slice(v.Depts, func(i, j int) bool { return v.Depts[i].ID < v.Depts[j].ID })
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM choices WHERE status = 'open'`).Scan(&v.Choices); err != nil {
		return v, err
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM tasks WHERE status = 'draft'`).Scan(&v.Drafts); err != nil {
		return v, err
	}
	if v.Goals, err = ledger.ReadGoals(ctx, db, now); err != nil {
		return v, err
	}
	backlogs, err := events.Backlogs(ctx, db)
	if err != nil {
		return v, err
	}
	v.Secretary.Listening = events.Listening(events.Secretary)
	for _, b := range backlogs {
		if b.Target == events.Secretary {
			v.Secretary.Pending, v.Secretary.Unheard = b.Count, b.OldestFree
			v.Secretary.Red = Level(Holder{Role: RoleSecretary, Since: b.OldestFree}, now) > 0
		}
	}
	entries, err := env.Pause.List(ctx)
	if err != nil {
		return v, err
	}
	for _, e := range entries {
		v.Paused = append(v.Paused, e.Scope)
	}
	return v, nil
}

func Routes(r *api.Router, env *app.Env) {
	r.Handle("GET /api/top", func(q *api.Req) (any, error) { return BuildView(q.Context(), env) })
	r.Handle("GET /api/tasks/{id}/holder", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "t")
		if err != nil {
			return nil, err
		}
		t, err := ledger.Get(q.Context(), env.DB, id)
		if err != nil {
			return nil, err
		}
		f, err := FactsOf(q.Context(), env.DB, t)
		if err != nil {
			return nil, err
		}
		h := HolderOf(f)
		return map[string]any{"holder": h, "overdue": Level(h, store.Now())}, nil
	})
	r.Handle("GET /api/watch/rules", func(q *api.Req) (any, error) { return Rules, nil })
}

func Commands(t *cli.Table) {
	t.Add(cli.Command{Path: "top", Summary: "全景：谁在干活、等你拍板的、各部门在跑与卡住、排队、三个目标的数；缺省每 3 秒刷新",
		Flags: []cli.Flag{{Name: "once", Bool: true, Help: "只看一次（--json 时总是一次）"}},
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(0); err != nil {
				return err
			}
			for {
				var v View
				var err error
				if c.JSON {
					err = c.Call("GET", "/api/top", nil, &v)
				} else {
					v, err = readTopView(c)
				}
				if err != nil {
					return err
				}
				if c.JSON || c.Bool("once") {
					return c.Done(v, Render(v), nextOf(v))
				}
				fmt.Fprint(c.Env.Stdout, "\x1b[H\x1b[2J"+Render(v)+"\n（Ctrl-C 退出）\n")
				select {
				case <-c.Context.Done():
					return nil
				case <-time.After(3 * time.Second):
				}
			}
		}})
}

func nextOf(v View) string {
	switch {
	case v.Choices > 0:
		return "atrium choice ls"
	case v.Secretary.Pending > 0:
		return "atrium events wait"
	}
	for _, t := range v.Tasks {
		if t.Overdue > 0 {
			return "atrium task show " + t.ID
		}
	}
	return "atrium task ls"
}

// Render 是 top 的人读版。
func Render(v View) string {
	var b strings.Builder
	if len(v.Paused) > 0 {
		fmt.Fprintf(&b, "已暂停：%s\n\n", strings.Join(v.Paused, "、"))
	}
	work := v.Working()
	fmt.Fprintf(&b, "在干活（%d）\n", len(work))
	for _, t := range work {
		fmt.Fprintf(&b, "  %s  %s  %s  %s%s\n", t.ID, clip(t.Title, 30), orDash(t.Worker), orDash(t.Host), heldSuffix(t.Holder, v.At))
	}
	fmt.Fprintf(&b, "\n等你：选项单 %d", v.Choices)
	if v.Secretary.Pending > 0 {
		fmt.Fprintf(&b, " · 秘书待处理事件 %d", v.Secretary.Pending)
	}
	b.WriteString("\n")
	var others []TaskRow
	for _, t := range v.Tasks {
		if t.Holder.Kind != "worker" && t.Holder.Kind != "runtime" && t.Holder.Kind != "deps" {
			others = append(others, t)
		}
	}
	if len(others) > 0 {
		b.WriteString("\n在别人手里\n")
		for _, t := range others {
			mark := ""
			if t.Overdue > 0 {
				mark = "  已到期"
			}
			h := t.Holder
			if owner, ok := v.Owners[t.ID]; h.Kind == "children" && ok {
				h.Who = owner
				if h.Who == "" {
					h.Who = "未记录处理人"
				}
			}
			fmt.Fprintf(&b, "  %s  %s  %s：%s%s%s\n", t.ID, clip(t.Title, 30), v.HolderWho(h), t.Holder.Text,
				heldSuffix(t.Holder, v.At), mark)
		}
	}
	if len(v.Depts) > 0 {
		b.WriteString("\n部门\n")
		for _, d := range v.Depts {
			fmt.Fprintf(&b, "  %s %s  在跑 %d · 卡住 %d\n", d.ID, d.Name, d.Running, d.Stuck)
		}
	}
	fmt.Fprintf(&b, "\n排队 %d", v.Queued)
	if v.Drafts > 0 {
		fmt.Fprintf(&b, " · 草稿 %d", v.Drafts)
	}
	fmt.Fprintf(&b, " · 秘书%s", listenText(v.Secretary))
	fmt.Fprintf(&b, "\n三个目标  %s", v.Goals.Line())
	return b.String()
}

func listenText(s SecretaryView) string {
	switch {
	case s.Red:
		return "没在听（有事件超过 3 分钟没人取）"
	case s.Listening != nil:
		return "在听"
	}
	return "不在听"
}

func heldSuffix(h Holder, now int64) string {
	if h.Since == 0 {
		return ""
	}
	return "  " + Held(h.Since, now)
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}
