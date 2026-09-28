package web

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/watch"
)

// 本文件是网页的只读数据：任务与部门走 ledger、org 的读函数；决定、选项单、资料、身份、机器这些
// 表所属的包还没有读函数，先在这里直接查（只读、参数化、有界）。那些包补了读函数后换成调用。
// 额度（quota）与持球表（watch）还是桩：接口返回空，界面显示空态。

// Row 是任务列表的一行。
type Row struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Dept  string `json:"dept,omitempty"`
	Group string `json:"group,omitempty"` // 今天页分组用的一级部门
	State string `json:"state"`
	Who   string `json:"who"`
	At    int64  `json:"at"` // 行尾时间：在做的是开始（最近变化）时间，完成的是结束时间
}

func toRow(t ledger.Task, parents map[string]string) Row {
	r := Row{ID: t.ID, Title: t.Title, Dept: t.Org, State: state(t), Who: who(t), At: t.UpdatedAt}
	if t.FinishedAt != nil {
		r.At = *t.FinishedAt
	}
	if t.Org != "" {
		r.Group = topGroup(parents, t.Org)
	}
	return r
}

// DeptBrief 是侧栏与卡片里的部门。
type DeptBrief struct {
	ID      string `json:"id"`
	Parent  string `json:"parent,omitempty"`
	Name    string `json:"name"`
	What    string `json:"what,omitempty"`
	Running int    `json:"running"`
	Stuck   int    `json:"stuck"`
}

// orgIndex 是全部部门（≤ org.MaxDepts）与每个部门整棵子树的在做、卡住数。
type orgIndex struct {
	list     []DeptBrief
	byID     map[string]*DeptBrief
	parents  map[string]string
	children map[string][]string
}

func loadOrg(ctx context.Context, q store.Querier) (*orgIndex, error) {
	forest, err := org.Tree(ctx, q)
	if err != nil {
		return nil, err
	}
	ix := &orgIndex{byID: map[string]*DeptBrief{}, parents: map[string]string{}, children: map[string][]string{}}
	var walk func(ns []*org.Node)
	walk = func(ns []*org.Node) {
		for _, n := range ns {
			ix.list = append(ix.list, DeptBrief{ID: n.ID, Parent: n.Parent, Name: n.Name, What: n.What})
			ix.parents[n.ID] = n.Parent
			ix.children[n.Parent] = append(ix.children[n.Parent], n.ID)
			walk(n.Children)
		}
	}
	walk(forest)
	for i := range ix.list {
		ix.byID[ix.list[i].ID] = &ix.list[i]
	}
	rows, err := q.QueryContext(ctx, `SELECT department, status, count(*) FROM tasks
		WHERE status IN ('running', 'blocked', 'failed') AND department IS NOT NULL
		AND (status = 'running' OR finished_at IS NULL OR finished_at > ?) GROUP BY department, status LIMIT 5000`,
		time.Now().Add(-24*time.Hour).UnixMilli())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var dept, st string
		var n int
		if err := rows.Scan(&dept, &st, &n); err != nil {
			return nil, err
		}
		for id := dept; id != ""; id = ix.parents[id] {
			d := ix.byID[id]
			if d == nil {
				break
			}
			if st == "running" {
				d.Running += n
			} else {
				d.Stuck += n
			}
		}
	}
	return ix, rows.Err()
}

func (ix *orgIndex) name(id string) string {
	if d := ix.byID[id]; d != nil {
		return d.Name
	}
	return ""
}

// subtree 返回 id 及全部下属部门。
func (ix *orgIndex) subtree(id string) []string {
	out := []string{id}
	for i := 0; i < len(out); i++ {
		out = append(out, ix.children[out[i]]...)
	}
	return out
}

// Nav 是侧栏：部门树与等你的件数。
type Nav struct {
	Depts []DeptBrief `json:"depts"`
	Asks  int         `json:"asks"`
}

func loadNav(ctx context.Context, q store.Querier) (Nav, error) {
	ix, err := loadOrg(ctx, q)
	if err != nil {
		return Nav{}, err
	}
	asks, err := loadAsks(ctx, q, ix)
	if err != nil {
		return Nav{}, err
	}
	return Nav{Depts: nonNil(ix.list), Asks: len(asks)}, nil
}

// Ask 是「等你」的一件：选项单等你挑，或卡住的任务递到了你这层（往上没有负责人）。
type Ask struct {
	Kind     string `json:"kind"` // choose | stuck
	ID       string `json:"id"`
	Title    string `json:"title"`
	Sub      string `json:"sub"`
	Dept     string `json:"dept,omitempty"`
	DeptName string `json:"dept_name,omitempty"`
	At       int64  `json:"at"`
}

func loadAsks(ctx context.Context, q store.Querier, ix *orgIndex) ([]Ask, error) {
	var out []Ask
	rows, err := q.QueryContext(ctx, `SELECT c.id, c.title, c.department, c.created_at,
		(SELECT count(*) FROM choice_options o WHERE o.choice = c.id)
		FROM choices c WHERE c.status = 'open' ORDER BY c.created_at DESC LIMIT 50`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var a Ask
		var n int
		if err := rows.Scan(&a.ID, &a.Title, &a.Dept, &a.At, &n); err != nil {
			rows.Close()
			return nil, err
		}
		a.Kind, a.Sub, a.DeptName = "choose", fmt.Sprintf("%d 个方向，挑哪几个", n), ix.name(a.Dept)
		out = append(out, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	blocked, err := ledger.List(ctx, q, ledger.Filter{Status: []ledger.Status{ledger.Blocked}, Limit: 50})
	if err != nil {
		return nil, err
	}
	for _, t := range blocked {
		// 有负责人的部门里卡住的先归负责人；往上都没有负责人的才递到你这层。
		owner, err := org.Recipient(ctx, q, t.Org)
		if err != nil {
			return nil, err
		}
		if owner != org.Secretary {
			continue
		}
		sub, err := lastReason(ctx, q, t.ID)
		if err != nil {
			return nil, err
		}
		if sub == "" {
			sub = "卡住，等处理"
		}
		out = append(out, Ask{Kind: "stuck", ID: t.ID, Title: t.Title, Sub: sub, Dept: t.Org, DeptName: ix.name(t.Org), At: t.UpdatedAt})
	}
	return out, nil
}

// lastReason 取任务最近一次状态变化或备注里写的原因。
func lastReason(ctx context.Context, q store.Querier, id string) (string, error) {
	hist, err := ledger.History(ctx, q, id, 5)
	if err != nil {
		return "", err
	}
	for i := len(hist) - 1; i >= 0; i-- {
		if s := eventText(hist[i]); s != "" {
			return s, nil
		}
	}
	return "", nil
}

// Today 是今天页。
type Today struct {
	Asks    []Ask  `json:"asks"`
	Running []Row  `json:"running"`
	Queued  int    `json:"queued"`
	Shipped []Row  `json:"shipped"`
	Groups  []Pair `json:"groups"` // 分组的一级部门 id 与名字
}

// Pair 是 id 与名字。
type Pair struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func loadToday(ctx context.Context, q store.Querier, now time.Time) (Today, error) {
	ix, err := loadOrg(ctx, q)
	if err != nil {
		return Today{}, err
	}
	asks, err := loadAsks(ctx, q, ix)
	if err != nil {
		return Today{}, err
	}
	running, err := ledger.List(ctx, q, ledger.Filter{Status: []ledger.Status{ledger.Running}, Limit: 200})
	if err != nil {
		return Today{}, err
	}
	var queued int
	if err := q.QueryRowContext(ctx, `SELECT count(*) FROM tasks WHERE status = 'queued'`).Scan(&queued); err != nil {
		return Today{}, err
	}
	done, err := finishedSince(ctx, q, startOfDay(now))
	if err != nil {
		return Today{}, err
	}
	out := Today{Asks: nonNil(asks), Queued: queued, Running: []Row{}, Shipped: []Row{}, Groups: []Pair{}}
	seen := map[string]bool{}
	for _, t := range running {
		r := toRow(t, ix.parents)
		out.Running = append(out.Running, r)
		if r.Group != "" && !seen[r.Group] {
			seen[r.Group] = true
			out.Groups = append(out.Groups, Pair{r.Group, ix.name(r.Group)})
		}
	}
	for _, t := range done {
		out.Shipped = append(out.Shipped, toRow(t, ix.parents))
	}
	return out, nil
}

// finishedSince 是某时刻以后完成的任务（按完成先后倒序）。
func finishedSince(ctx context.Context, q store.Querier, since int64) ([]ledger.Task, error) {
	rows, err := q.QueryContext(ctx, `SELECT id FROM tasks WHERE status = 'done' AND finished_at >= ?
		ORDER BY finished_at DESC LIMIT 100`, since)
	if err != nil {
		return nil, err
	}
	ids, err := scanIDs(rows)
	if err != nil {
		return nil, err
	}
	return getTasks(ctx, q, ids)
}

func scanIDs(rows *sql.Rows) ([]string, error) {
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func getTasks(ctx context.Context, q store.Querier, ids []string) ([]ledger.Task, error) {
	out := make([]ledger.Task, 0, len(ids))
	for _, id := range ids {
		t, err := ledger.Get(ctx, q, id)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

// DeptPage 是部门页。
type DeptPage struct {
	Dept      org.Dept    `json:"dept"`
	Path      []Pair      `json:"path"`
	Leader    *Leader     `json:"leader"`
	Subs      []DeptBrief `json:"subs"`
	Tasks     []Row       `json:"tasks"`
	Rules     []Rule      `json:"rules"`
	Inherited []Rule      `json:"inherited"`
	RuleMax   int         `json:"rule_max"`
	Materials []Material  `json:"materials"`
}

// Leader 是部门负责人。
type Leader struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Workers string `json:"workers"`
}

// Rule 是一条要点（规矩）。
type Rule struct {
	ID       string `json:"id"`
	Text     string `json:"text"`
	Why      string `json:"why,omitempty"`
	By       string `json:"by"`
	Dept     string `json:"dept"`
	DeptName string `json:"dept_name"`
}

// Material 是一份资料的当前版本。
type Material struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Kind  string `json:"kind"`
	Rev   int    `json:"rev"`
	Size  int64  `json:"size"`
	At    int64  `json:"at"`
}

func loadDept(ctx context.Context, q store.Querier, id string) (DeptPage, error) {
	d, err := org.Get(ctx, q, id)
	if err != nil {
		return DeptPage{}, err
	}
	ix, err := loadOrg(ctx, q)
	if err != nil {
		return DeptPage{}, err
	}
	page := DeptPage{Dept: d, Path: []Pair{}, Subs: []DeptBrief{}, Rules: []Rule{}, Inherited: []Rule{}, RuleMax: org.MaxPoints}
	chain, err := org.Ancestors(ctx, q, id)
	if err != nil {
		return DeptPage{}, err
	}
	for _, a := range chain[:len(chain)-1] {
		page.Path = append(page.Path, Pair{a, ix.name(a)})
	}
	if d.Leader != "" {
		l, err := org.GetIdentity(ctx, q, d.Leader)
		if err != nil {
			return DeptPage{}, err
		}
		page.Leader = &Leader{ID: l.ID, Name: l.Name, Workers: strings.Join(l.Workers, "、")}
	}
	for _, s := range ix.children[id] {
		page.Subs = append(page.Subs, *ix.byID[s])
	}
	if page.Tasks, err = deptTasks(ctx, q, ix, id); err != nil {
		return DeptPage{}, err
	}
	points, err := org.Chain(ctx, q, id)
	if err != nil {
		return DeptPage{}, err
	}
	for _, p := range points {
		if p.Org != id {
			page.Inherited = append(page.Inherited, Rule{ID: p.ID, Text: p.Text, Why: p.Why, By: p.By, Dept: p.Org, DeptName: ix.name(p.Org)})
		}
	}
	// 本部门的要点自己查、不截在上限：导入的旧数据可能超过 7 条，网页要把超出的也摆出来让你整理。
	if page.Rules, err = ownRules(ctx, q, id, ix.name(id)); err != nil {
		return DeptPage{}, err
	}
	if page.Materials, err = deptMaterials(ctx, q, id); err != nil {
		return DeptPage{}, err
	}
	return page, nil
}

func ownRules(ctx context.Context, q store.Querier, id, name string) ([]Rule, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, text, why, decided_by FROM points WHERE department = ? ORDER BY pos LIMIT 100`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Rule{}
	for rows.Next() {
		r := Rule{Dept: id, DeptName: name}
		if err := rows.Scan(&r.ID, &r.Text, &r.Why, &r.By); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// deptTasks 是部门整棵子树里没结束的任务，加上 3 天内结束的（最多 100 件，最近的在前）。
func deptTasks(ctx context.Context, q store.Querier, ix *orgIndex, id string) ([]Row, error) {
	ids := ix.subtree(id)
	marks := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids)+1)
	for _, d := range ids {
		args = append(args, d)
	}
	args = append(args, time.Now().Add(-72*time.Hour).UnixMilli())
	rows, err := q.QueryContext(ctx, `SELECT id FROM tasks WHERE department IN (`+marks+`)
		AND (finished_at IS NULL OR finished_at > ?) ORDER BY updated_at DESC LIMIT 100`, args...)
	if err != nil {
		return nil, err
	}
	tids, err := scanIDs(rows)
	if err != nil {
		return nil, err
	}
	tasks, err := getTasks(ctx, q, tids)
	if err != nil {
		return nil, err
	}
	out := make([]Row, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, toRow(t, ix.parents))
	}
	return out, nil
}

// deptMaterials 是部门没归档的资料，每份取最新一版。
func deptMaterials(ctx context.Context, q store.Querier, id string) ([]Material, error) {
	rows, err := q.QueryContext(ctx, `SELECT m.id, m.title, m.kind, m.rev, m.size, m.created_at FROM materials m
		WHERE m.department = ? AND m.archived_at IS NULL
		AND m.rev = (SELECT max(rev) FROM materials x WHERE x.id = m.id)
		ORDER BY m.kind DESC, m.created_at DESC LIMIT 200`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Material{}
	for rows.Next() {
		var m Material
		if err := rows.Scan(&m.ID, &m.Title, &m.Kind, &m.Rev, &m.Size, &m.At); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// DecisionRow 是一条有效决定（没被后来的推翻）。
type DecisionRow struct {
	ID       string `json:"id"`
	Text     string `json:"text"`
	Why      string `json:"why"`
	Dept     string `json:"dept"`
	DeptName string `json:"dept_name"`
	At       int64  `json:"at"`
}

func loadDecisions(ctx context.Context, q store.Querier) ([]DecisionRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT d.id, d.text, d.why, d.department, COALESCE(p.name, ''), d.created_at
		FROM decisions d LEFT JOIN departments p ON p.id = d.department
		WHERE NOT EXISTS (SELECT 1 FROM decisions n WHERE n.supersedes = d.id)
		ORDER BY d.created_at DESC, d.rowid DESC LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DecisionRow{}
	for rows.Next() {
		var d DecisionRow
		if err := rows.Scan(&d.ID, &d.Text, &d.Why, &d.Dept, &d.DeptName, &d.At); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// Legion 是执行者页：额度、机器、组合表现。
type Legion struct {
	Accounts []Account `json:"accounts"`
	Hosts    []Host    `json:"hosts"`
	Perf     []Perf    `json:"perf"`
}

// Account 是一个账号的额度（quota 包实现后填）。Reserve 是给用户自己留的百分比。
type Account struct {
	Name    string `json:"name"`
	Left    int    `json:"left"`
	Reserve int    `json:"reserve"`
	Note    string `json:"note"`
}

// Host 是一台机器与它的空位。
type Host struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Slots    int    `json:"slots"`
	Busy     int    `json:"busy"`
	Online   bool   `json:"online"`
	LastSeen *int64 `json:"last_seen,omitempty"`
}

// Perf 是一个执行者组合的交付表现：完成件数与一次通过（没被交回过）的比例。
type Perf struct {
	Worker    string `json:"worker"`
	Delivered int    `json:"delivered"`
	FirstPass int    `json:"first_pass"` // 百分比
}

func loadLegion(ctx context.Context, q store.Querier, now int64) (Legion, error) {
	out := Legion{Accounts: []Account{}, Hosts: []Host{}, Perf: []Perf{}}
	rows, err := q.QueryContext(ctx, `SELECT h.id, h.name, h.kind, h.slots, h.last_seen_at,
		(SELECT count(*) FROM tasks t WHERE t.host = h.id AND t.status = 'running')
		FROM hosts h ORDER BY h.kind = 'remote', h.created_at, h.id LIMIT 200`)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var h Host
		var seen sql.NullInt64
		if err := rows.Scan(&h.ID, &h.Name, &h.Kind, &h.Slots, &seen, &h.Busy); err != nil {
			rows.Close()
			return out, err
		}
		if seen.Valid {
			h.LastSeen = &seen.Int64
		}
		h.Online = hostOnline(h.Kind, h.LastSeen, now)
		out.Hosts = append(out.Hosts, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	rows, err = q.QueryContext(ctx, `SELECT t.worker, count(*),
		sum(CASE WHEN EXISTS (SELECT 1 FROM task_events e WHERE e.task = t.id AND e.kind = 'bounce') THEN 0 ELSE 1 END)
		FROM tasks t WHERE t.status = 'done' AND t.worker <> '' GROUP BY t.worker ORDER BY 2 DESC, 1 LIMIT 50`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var p Perf
		var clean int
		if err := rows.Scan(&p.Worker, &p.Delivered, &clean); err != nil {
			return out, err
		}
		p.FirstPass = clean * 100 / p.Delivered
		out.Perf = append(out.Perf, p)
	}
	return out, rows.Err()
}

// TaskDetail 是任务抽屉。
type TaskDetail struct {
	Task     ledger.Task `json:"task"`
	DeptName string      `json:"dept_name"`
	Steps    []string    `json:"steps"`
	Step     int         `json:"step"`
	State    string      `json:"state"`
	Holder   string      `json:"holder"`
	HostName string      `json:"host_name"`
	Log      []LogLine   `json:"log"`
}

// LogLine 是任务经历的一行（抽屉里的日志尾巴）。
type LogLine struct {
	At   int64  `json:"at"`
	Text string `json:"text"`
}

func loadTask(ctx context.Context, q store.Querier, id string) (TaskDetail, error) {
	t, err := ledger.Get(ctx, q, id)
	if err != nil {
		return TaskDetail{}, err
	}
	out := TaskDetail{Task: t, Steps: Steps, Step: step(t), State: state(t), Log: []LogLine{}}
	if out.Holder, err = holderText(ctx, q, t); err != nil {
		return out, err
	}
	if t.Org != "" {
		if err := q.QueryRowContext(ctx, `SELECT name FROM departments WHERE id = ?`, t.Org).Scan(&out.DeptName); err != nil {
			return out, err
		}
	}
	if t.Host != "" {
		err := q.QueryRowContext(ctx, `SELECT name FROM hosts WHERE id = ?`, t.Host).Scan(&out.HostName)
		if err != nil && !store.IsNotFound(err) {
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
	hist, err := ledger.History(ctx, q, id, 12)
	if err != nil {
		return out, err
	}
	for _, e := range hist {
		out.Log = append(out.Log, LogLine{At: e.At, Text: logLine(e)})
	}
	return out, nil
}

// holderText 是「现在谁拿着球」：没结束的任务用 watch 的持球判定（与 top、statusline 同一份），
// 结束了的按结果说。
func holderText(ctx context.Context, q store.Querier, t ledger.Task) (string, error) {
	if t.Status.Finished() && t.Status != ledger.Failed {
		return finishedText(t), nil
	}
	owner, err := org.Recipient(ctx, q, t.Org)
	if err != nil {
		return "", err
	}
	deps, err := ledger.Deps(ctx, q, t.ID)
	if err != nil {
		return "", err
	}
	_, waiting := ledger.Ready(t.Status, deps)
	h := watch.HolderOf(watch.Facts{Task: t, Owner: owner, WaitingOn: waiting})
	if h.Who == "" {
		return h.Text, nil
	}
	who := h.Who
	if who == org.Secretary {
		who = "秘书"
	}
	return who + "：" + h.Text, nil
}

// ChoiceDetail 是选项单抽屉。
type ChoiceDetail struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Status   string   `json:"status"`
	Note     string   `json:"note"`
	Dept     string   `json:"dept"`
	DeptName string   `json:"dept_name"`
	Task     string   `json:"task,omitempty"`
	At       int64    `json:"at"`
	Options  []Option `json:"options"`
}

// Option 是选项单的一项。
type Option struct {
	Pos    int    `json:"pos"`
	Title  string `json:"title"`
	Gain   string `json:"gain"`
	Cost   string `json:"cost"`
	Picked bool   `json:"picked"`
}

func loadChoice(ctx context.Context, q store.Querier, id string) (ChoiceDetail, error) {
	var c ChoiceDetail
	var task sql.NullString
	err := q.QueryRowContext(ctx, `SELECT c.id, c.title, c.status, c.note, c.department, COALESCE(d.name, ''), c.task, c.created_at
		FROM choices c LEFT JOIN departments d ON d.id = c.department WHERE c.id = ?`, id).
		Scan(&c.ID, &c.Title, &c.Status, &c.Note, &c.Dept, &c.DeptName, &task, &c.At)
	if store.IsNotFound(err) {
		return c, api.NotFound("选项单 %s 不存在", id)
	}
	if err != nil {
		return c, err
	}
	c.Task = task.String
	rows, err := q.QueryContext(ctx, `SELECT pos, title, gain, cost, picked FROM choice_options WHERE choice = ? ORDER BY pos LIMIT 20`, id)
	if err != nil {
		return c, err
	}
	defer rows.Close()
	c.Options = []Option{}
	for rows.Next() {
		var o Option
		if err := rows.Scan(&o.Pos, &o.Title, &o.Gain, &o.Cost, &o.Picked); err != nil {
			return c, err
		}
		c.Options = append(c.Options, o)
	}
	return c, rows.Err()
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
