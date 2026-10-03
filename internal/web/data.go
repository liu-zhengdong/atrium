package web

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/watch"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 本文件是网页的只读数据：尽量走各包的读函数；还没有读函数的，先在这里直接查（只读、参数化、有界）。

// Row 是任务列表的一行。
type Row struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Dept  string `json:"dept,omitempty"`
	Group string `json:"group,omitempty"` // 今天页「按部门」排序用的一级部门
	State string `json:"state"`
	Who   string `json:"who"`
	At    int64  `json:"at"`             // 行尾时间：在做的是开始（最近变化）时间，完成的是结束时间
	Kids  []Row  `json:"kids,omitempty"` // 子任务（按建立先后）；只有部门页排成树
}

// toRow 是一件任务的列表行；h 是它的等待对象（watch.HolderOf）。
func toRow(t ledger.Task, parents map[string]string, h watch.Holder) Row {
	r := Row{ID: t.ID, Title: t.Title, Dept: t.Org, State: state(t, h), Who: who(t, h), At: t.UpdatedAt}
	if t.FinishedAt != nil {
		r.At = *t.FinishedAt
	}
	if t.Org != "" {
		r.Group = topGroup(parents, t.Org)
	}
	return r
}

// rowOf 是 toRow 加上判定等待对象要的事实：待派、排队的查依赖；子任务数 kids 由调用方从已加载的任务里数。
// 行尾不写负责人是谁，所以不取 Owner。
func rowOf(ctx context.Context, q store.Querier, t ledger.Task, parents map[string]string, kids kidCount) (Row, error) {
	f := watch.Facts{Task: t, OpenChildren: kids.open, Children: kids.all}
	if t.Status == ledger.Todo || t.Status == ledger.Queued {
		var err error
		if f.Deps, err = ledger.Deps(ctx, q, t.ID); err != nil {
			return Row{}, err
		}
	}
	return toRow(t, parents, watch.HolderOf(f)), nil
}

// looseRow 是零散加载的一件任务的行（抽屉里的上级与依赖、定时任务的各轮）：子任务没加载，待派的单独数一次。
func looseRow(ctx context.Context, q store.Querier, t ledger.Task, parents map[string]string) (Row, error) {
	var kids kidCount
	if t.Status == ledger.Todo {
		var err error
		if kids.open, kids.all, err = ledger.Children(ctx, q, t.ID); err != nil {
			return Row{}, err
		}
	}
	return rowOf(ctx, q, t, parents, kids)
}

// kidCount 是一件任务的直接子任务数：没结束的与全部。
type kidCount struct{ open, all int }

// countKids 从已加载的任务里数每件任务的直接子任务；调用方要保证加载了所数父任务的全部子任务。
func countKids(tasks []ledger.Task) map[string]kidCount {
	out := map[string]kidCount{}
	for _, t := range tasks {
		if t.Parent == "" {
			continue
		}
		c := out[t.Parent]
		c.all++
		if !t.Status.Finished() {
			c.open++
		}
		out[t.Parent] = c
	}
	return out
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

// orgIndex 是全部部门（≤ org.MaxDepts）与每个部门整棵子树的在做、卡住数，另带身份与机器的名字（loadNames）。
type orgIndex struct {
	list     []DeptBrief
	byID     map[string]*DeptBrief
	parents  map[string]string
	children map[string][]string
	names    map[string]string
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
	if ix.names, err = loadNames(ctx, q); err != nil {
		return nil, err
	}
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

// name 是页面上提到部门、身份、机器时写的名字；没登记的原样给短号。
func (ix *orgIndex) name(id string) string {
	if d := ix.byID[id]; d != nil {
		return d.Name
	}
	if n, ok := ix.names[id]; ok {
		return n
	}
	return id
}

// loadNames 是网页上会提到的身份与机器的名字（部门名在部门树里）：用户写「你」（网页是给你看的），秘书、负责人、机器取登记的名字。
// 页面一律经它把短号换成名字，前端拿到的是同一份（Nav.Names）。
func loadNames(ctx context.Context, q store.Querier) (map[string]string, error) {
	out := map[string]string{"u1": "你", org.Secretary: "秘书"}
	leaders, err := org.Leaders(ctx, q)
	if err != nil {
		return nil, err
	}
	for _, l := range leaders {
		out[l.ID] = l.Name
	}
	list, err := hosts.List(ctx, q)
	if err != nil {
		return nil, err
	}
	for _, h := range list {
		out[h.ID] = h.Name
	}
	return out, nil
}

// subtree 返回 id 及全部下属部门。
func (ix *orgIndex) subtree(id string) []string {
	out := []string{id}
	for i := 0; i < len(out); i++ {
		out = append(out, ix.children[out[i]]...)
	}
	return out
}

// Nav 是侧栏：部门树与等你的件数；Names 是身份与机器的名字，页面上提到它们时查这张表。
type Nav struct {
	Depts     []DeptBrief       `json:"depts"`
	Names     map[string]string `json:"names"`
	Asks      int               `json:"asks"`
	ShippedID int64             `json:"shipped_id"` // 最近 shipped 上报事件号；跨页面共用，不把任务结束算作上线
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
	var shippedID int64
	if err := q.QueryRowContext(ctx, `SELECT COALESCE(MAX(id), 0) FROM events
		WHERE kind = ? AND json_extract(body, '$.kind') = ?`, events.LeaderEscalate, "shipped").Scan(&shippedID); err != nil {
		return Nav{}, err
	}
	return Nav{Depts: nonNil(ix.list), Names: ix.names, Asks: len(asks), ShippedID: shippedID}, nil
}

// Ask 是「等你」的一件：选项单等你挑，交付等你验收（部门的验收人是你），负责人在问你、等你回话的任务（回话后消失），
// 卡住的任务递到了你这层（往上没有负责人），负责人上报到秘书这层还没处理的事，或等人处理的执行者不可用标记（没登录、缺环境、
// 模型名无效、自检不过；从 worker_marks 现读，解除就消失；额度用尽这类会自己恢复的不算）。
type Ask struct {
	Kind     string `json:"kind"` // choose | accept | reply | stuck | escalate | worker
	ID       string `json:"id"`
	Title    string `json:"title"`
	Sub      string `json:"sub"`
	Dept     string `json:"dept,omitempty"`
	DeptName string `json:"dept_name,omitempty"`
	At       int64  `json:"at"`
}

func loadAsks(ctx context.Context, q store.Querier, ix *orgIndex) ([]Ask, error) {
	var out []Ask
	open, err := agenda.Choices(ctx, q, "", false)
	if err != nil {
		return nil, err
	}
	for _, c := range open {
		sub := fmt.Sprintf("%d 个方向，挑哪几个", len(c.Options))
		if len(c.Recommend) > 0 {
			sub = fmt.Sprintf("%d 个方向，推荐 %s", len(c.Options), joinInts(c.Recommend))
		}
		out = append(out, Ask{Kind: "choose", ID: c.ID, Title: c.Title, Sub: sub, Dept: c.Org, DeptName: ix.name(c.Org), At: c.CreatedAt})
	}
	running, err := ledger.List(ctx, q, ledger.Filter{Status: []ledger.Status{ledger.Running}, Limit: 500})
	if err != nil {
		return nil, err
	}
	for _, t := range running {
		if t.Stage != ledger.StageAccept {
			continue
		}
		who, _, err := org.Acceptor(ctx, q, t.Org)
		if err != nil {
			return nil, err
		}
		if who != org.AcceptUser {
			continue
		}
		out = append(out, Ask{Kind: "accept", ID: t.ID, Title: t.Title, Sub: "等你验收：atrium task accept " + t.ID + "，或 task reject " + t.ID + " --reason 原因",
			Dept: t.Org, DeptName: ix.name(t.Org), At: t.UpdatedAt})
	}
	asking, err := ledger.List(ctx, q, ledger.Filter{Status: []ledger.Status{ledger.Todo}, Asking: true, Limit: 200})
	if err != nil {
		return nil, err
	}
	for _, t := range asking {
		out = append(out, Ask{Kind: "reply", ID: t.ID, Title: t.Title, Sub: t.Ask, Dept: t.Org, DeptName: ix.name(t.Org), At: t.AskedAt})
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
	ups, err := escalations(ctx, q, ix)
	if err != nil {
		return nil, err
	}
	marks, err := workers.Marks(ctx, q, store.Now())
	if err != nil {
		return nil, err
	}
	for _, m := range marks {
		if m.Until == 0 {
			spec := workers.Spec{Tool: m.Tool, Model: m.Model}.String()
			ups = append(ups, Ask{Kind: "worker", ID: m.Target(), Title: spec + "（" + ix.name(m.Host) + "）" + m.Reason, Sub: m.Fix(), At: m.Since})
		}
	}
	return append(out, ups...), nil
}

// escalations 是负责人上报到秘书这层（往上没有负责人）、要处理、还没确认的事件。知会不算；问用户挂在任务上，按任务列（reply）。
func escalations(ctx context.Context, q store.Querier, ix *orgIndex) ([]Ask, error) {
	rows, err := q.QueryContext(ctx, `SELECT COALESCE(task, ''), COALESCE(department, ''), body, updated_at FROM events
		WHERE kind = ? AND target = ? AND level = ? AND acked_at IS NULL
		AND COALESCE(json_extract(body, '$.kind'), '') NOT IN ('notify', 'ask') ORDER BY id LIMIT 200`, events.LeaderEscalate, org.Secretary, events.Act)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Ask
	for rows.Next() {
		var task, dept, raw string
		var at int64
		if err := rows.Scan(&task, &dept, &raw, &at); err != nil {
			return nil, err
		}
		var b struct{ From, Label, Note string }
		if err := json.Unmarshal([]byte(raw), &b); err != nil {
			return nil, fmt.Errorf("上报事件的内容坏了：%w", err)
		}
		out = append(out, Ask{Kind: "escalate", ID: task, Title: b.Note, Sub: ix.name(b.From) + " 上报：" + b.Label, Dept: dept, DeptName: ix.name(dept), At: at})
	}
	return out, rows.Err()
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
	Asks        []Ask        `json:"asks"`
	Running     []Row        `json:"running"`
	Queued      int          `json:"queued"`
	Drafts      int          `json:"drafts"` // 草稿只给数，点开到根部门的任务页
	Goals       ledger.Goals `json:"goals"`  // 三个目标的数（与 top 同一份）；页面只写近 7 天，累计在 top 里
	Shipped     []Row        `json:"shipped"`
	ShippedMore int          `json:"shipped_more"` // 今天完成但超出列表上限、没列出的件数
	Paused      []string     `json:"paused"`       // 暂停范围（all、oN、hN）；空表示没暂停
	Soon        Soon         `json:"soon"`
}

// Soon 是今天页「接下来 7 天」：7 天内到点的定时任务（按下一轮先后），更远的只给条数。
type Soon struct {
	Rows  []Sched `json:"rows"`
	Later int     `json:"later"`
}

const soonHorizon = 7 * 24 * time.Hour

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
	var drafts int
	if err := q.QueryRowContext(ctx, `SELECT count(*) FROM tasks WHERE status = 'draft'`).Scan(&drafts); err != nil {
		return Today{}, err
	}
	done, err := finishedSince(ctx, q, startOfDay(now))
	if err != nil {
		return Today{}, err
	}
	var doneAll int
	if err := q.QueryRowContext(ctx, `SELECT count(*) FROM tasks WHERE status = 'done' AND finished_at >= ?`, startOfDay(now)).Scan(&doneAll); err != nil {
		return Today{}, err
	}
	paused, err := pause.Active(ctx, q)
	if err != nil {
		return Today{}, err
	}
	goals, err := ledger.ReadGoals(ctx, q, now.UnixMilli())
	if err != nil {
		return Today{}, err
	}
	out := Today{Asks: nonNil(asks), Queued: queued, Drafts: drafts, Goals: goals, Running: []Row{}, Shipped: []Row{}, ShippedMore: doneAll - len(done), Paused: paused}
	// 在做的、完成的不看依赖和子任务，等待对象只凭任务自己就判得出。
	for _, t := range running {
		out.Running = append(out.Running, toRow(t, ix.parents, watch.HolderOf(watch.Facts{Task: t})))
	}
	for _, t := range done {
		out.Shipped = append(out.Shipped, toRow(t, ix.parents, watch.HolderOf(watch.Facts{Task: t})))
	}
	if out.Soon, err = loadSoon(ctx, q, ix, paused, now); err != nil {
		return Today{}, err
	}
	return out, nil
}

func loadSoon(ctx context.Context, q store.Querier, ix *orgIndex, paused []string, now time.Time) (Soon, error) {
	all, err := agenda.Schedules(ctx, q, "")
	if err != nil {
		return Soon{}, err
	}
	out := Soon{Rows: []Sched{}}
	for _, x := range all {
		if x.NextAt > now.Add(soonHorizon).UnixMilli() {
			out.Later++
			continue
		}
		r, err := toSched(ctx, q, x, ix, paused)
		if err != nil {
			return Soon{}, err
		}
		out.Rows = append(out.Rows, r)
	}
	sort.SliceStable(out.Rows, func(i, j int) bool { return out.Rows[i].NextAt < out.Rows[j].NextAt })
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
	Leader    *Leader     `json:"leader"`
	Subs      []DeptBrief `json:"subs"`
	Tasks     []Row       `json:"tasks"`
	Rules     []Rule      `json:"rules"`
	Inherited []Rule      `json:"inherited"`
	RuleMax   int         `json:"rule_max"`
	MemoMax   int         `json:"memo_max"` // 负责人备忘上限（字），抽屉里写「用量/上限」
	Accept    *Accept     `json:"accept"`   // 验收人（沿树继承）；缺省 auto 为空
	Materials []Material  `json:"materials"`
	MatMax    int         `json:"material_max"` // 资料文本总量上限（字），用量由页面按 units 合计
	Schedules []Sched     `json:"schedules"`
	SchedMax  int         `json:"schedule_max"`
}

// Material 是部门页里的一条资料；Frame 是 html 正文沙箱页面的地址前缀（/ui/frame/mN-<键>/，见 material.go）。
type Material struct {
	org.Material
	Frame string `json:"frame"`
}

// Leader 是部门负责人：自己没有就是往上最近一级的（Inherited），和事件投递同一个判定（org.Recipient）。
// Depts（直接负责的部门）与 Memo（备忘全文）在页面上点开负责人一行、在抽屉里显示。
type Leader struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Workers   string `json:"workers"`
	Inherited bool   `json:"inherited,omitempty"`
	Depts     []Pair `json:"depts"`
	Memo      string `json:"memo"`
}

// Accept 是部门页头的验收人：org.Acceptor 的结果，From 不是本部门时页面写「沿用 FromName」。
type Accept struct {
	Who      string `json:"who"` // leader 或 user
	From     string `json:"from"`
	FromName string `json:"from_name"`
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

func loadDept(ctx context.Context, q store.Querier, data, id string) (DeptPage, error) {
	d, err := org.Get(ctx, q, id)
	if err != nil {
		return DeptPage{}, err
	}
	ix, err := loadOrg(ctx, q)
	if err != nil {
		return DeptPage{}, err
	}
	page := DeptPage{Dept: d, Subs: []DeptBrief{}, Rules: []Rule{}, Inherited: []Rule{}, RuleMax: org.MaxPoints,
		MemoMax: org.MaxMemo, MatMax: org.MaxMaterial, Schedules: []Sched{}, SchedMax: org.MaxSchedules}
	lead, err := org.Recipient(ctx, q, id)
	if err != nil {
		return DeptPage{}, err
	}
	if lead != org.Secretary {
		l, err := org.GetIdentity(ctx, q, lead)
		if err != nil {
			return DeptPage{}, err
		}
		m, err := org.GetMemo(ctx, q, lead)
		if err != nil {
			return DeptPage{}, err
		}
		page.Leader = &Leader{ID: l.ID, Name: l.Name, Workers: strings.Join(l.Workers, "、"), Inherited: d.Leader != lead,
			Depts: []Pair{}, Memo: m.Body}
		for _, o := range l.Depts {
			page.Leader.Depts = append(page.Leader.Depts, Pair{o, ix.name(o)})
		}
	}
	who, from, err := org.Acceptor(ctx, q, id)
	if err != nil {
		return DeptPage{}, err
	}
	if who != org.AcceptAuto {
		page.Accept = &Accept{Who: who, From: from, FromName: ix.name(from)}
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
	// 本部门的要点不截在上限：导入的旧数据可能超过 7 条，网页全摆出来并标「超限 8/7」让你整理。
	if page.Rules, err = ownRules(ctx, q, id, ix.name(id)); err != nil {
		return DeptPage{}, err
	}
	mats, err := org.Materials(ctx, q, data, org.MaterialFilter{Org: id})
	if err != nil {
		return DeptPage{}, err
	}
	page.Materials = make([]Material, len(mats))
	for i, m := range mats {
		page.Materials[i] = Material{Material: m}
	}
	scheds, err := agenda.Schedules(ctx, q, id)
	if err != nil {
		return DeptPage{}, err
	}
	paused, err := pause.Active(ctx, q)
	if err != nil {
		return DeptPage{}, err
	}
	for _, x := range scheds {
		r, err := toSched(ctx, q, x, ix, paused)
		if err != nil {
			return DeptPage{}, err
		}
		page.Schedules = append(page.Schedules, r)
	}
	return page, nil
}

// Sched 是定时任务的一行：部门页、今天页「接下来 7 天」、抽屉共用。
type Sched struct {
	ID       string `json:"id"`
	Org      string `json:"org"`
	DeptName string `json:"dept_name"`
	Kind     string `json:"kind,omitempty"` // 体验巡检、调研才写；自定义的不写
	Title    string `json:"title"`
	Cadence  string `json:"cadence"` // 多久一轮（agenda.Cadence，与 schedule ls 同一份）
	Once     bool   `json:"once"`    // 一次性的：到点生成一次后删掉，没有下一轮
	NextAt   int64  `json:"next_at"`
	Paused   bool   `json:"paused"` // 在暂停范围内：到点不生成
	Last     *Row   `json:"last"`   // 上一轮生成的任务；还没跑过为空
	Skips    int    `json:"skips"`
	Note     string `json:"note,omitempty"` // 最近一笔记录（跳过、分派任务失败、停机错过）
	Trouble  bool   `json:"trouble"`        // 最近一轮分派任务失败
}

func toSched(ctx context.Context, q store.Querier, x agenda.Schedule, ix *orgIndex, paused []string) (Sched, error) {
	var chain []string
	for id := x.Org; id != ""; id = ix.parents[id] {
		chain = append(chain, id)
	}
	r := Sched{ID: x.ID, Org: x.Org, DeptName: ix.name(x.Org), Title: x.Title,
		Cadence: agenda.Cadence(x, time.Local), Once: x.Once, NextAt: x.NextAt, Paused: pause.Paused(paused, pause.Scope{Orgs: chain}),
		Skips: x.Skips, Note: x.LastNote, Trouble: strings.Contains(x.LastNote, agenda.DispatchFailed)}
	if x.Kind != "task" {
		r.Kind = agenda.Kinds[x.Kind]
	}
	if x.LastTask != "" {
		t, err := ledger.Get(ctx, q, x.LastTask)
		if err != nil {
			return Sched{}, err
		}
		last, err := looseRow(ctx, q, t, ix.parents)
		if err != nil {
			return Sched{}, err
		}
		r.Last = &last
	}
	return r, nil
}

// SchedDetail 是定时任务抽屉：一行的内容加上详述、技能、谁建的、最近几轮。
type SchedDetail struct {
	Sched
	Detail    string `json:"detail"`
	Skill     string `json:"skill,omitempty"`
	By        string `json:"by"`
	CreatedAt int64  `json:"created_at"`
	Rounds    []Row  `json:"rounds"` // 最近几轮，新的在前
}

const recentRounds = 5

func loadSchedule(ctx context.Context, q store.Querier, id string) (SchedDetail, error) {
	x, err := agenda.GetSchedule(ctx, q, id)
	if err != nil {
		return SchedDetail{}, err
	}
	ix, err := loadOrg(ctx, q)
	if err != nil {
		return SchedDetail{}, err
	}
	paused, err := pause.Active(ctx, q)
	if err != nil {
		return SchedDetail{}, err
	}
	row, err := toSched(ctx, q, x, ix, paused)
	if err != nil {
		return SchedDetail{}, err
	}
	out := SchedDetail{Sched: row, Detail: x.Detail, Skill: x.Skill, By: x.CreatedBy, CreatedAt: x.CreatedAt, Rounds: []Row{}}
	rounds, err := agenda.Rounds(ctx, q, id, recentRounds)
	if err != nil {
		return SchedDetail{}, err
	}
	for _, t := range rounds {
		r, err := looseRow(ctx, q, t, ix.parents)
		if err != nil {
			return SchedDetail{}, err
		}
		out.Rounds = append(out.Rounds, r)
	}
	return out, nil
}

func ownRules(ctx context.Context, q store.Querier, id, name string) ([]Rule, error) {
	ps, err := org.Points(ctx, q, id)
	if err != nil {
		return nil, err
	}
	out := []Rule{}
	for _, p := range ps {
		out = append(out, Rule{ID: p.ID, Text: p.Text, Why: p.Why, By: p.By, Dept: id, DeptName: name})
	}
	return out, nil
}

// Legion 是执行者页：额度（后台存下的读数）、机器、执行者目录。
type Legion struct {
	Quota
	Hosts   []Host        `json:"hosts"`
	Workers []workers.Row `json:"workers"`
	Window  int           `json:"window"` // 结果统计近几次拉起
}

// Quota 是执行者页的额度一块。
type Quota struct {
	Accounts []Account `json:"accounts"`
	Reserve  int       `json:"reserve"`
}

// Account 是一个账号的额度。Left 是剩下的百分比（没读数为 nil）；At 是读数的时刻（毫秒，没读数为 0），Stale 读数旧了。
type Account struct {
	Name  string `json:"name"`
	Left  *int   `json:"left"`
	Note  string `json:"note"`
	At    int64  `json:"at"`
	Stale bool   `json:"stale"`
}

// Host 是一台机器与它的空位；Paused 是这台机器（或全局）暂停着，到点不在它上面分派任务。
type Host struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Slots  int    `json:"slots"`
	Busy   int    `json:"busy"`
	Online bool   `json:"online"`
	Paused bool   `json:"paused"`
	Status string `json:"status"`
}

func loadLegion(ctx context.Context, env *app.Env, now int64) (Legion, error) {
	db := env.DB
	out := Legion{Quota: quotaOf(quota.Overview{}), Hosts: []Host{}, Workers: []workers.Row{}, Window: workers.StatWindow}
	ov, err := quota.Last(ctx, env)
	if err != nil {
		return out, err
	}
	out.Quota = quotaOf(ov)
	list, err := hosts.List(ctx, db)
	if err != nil {
		return out, err
	}
	busy, err := runningByHost(ctx, db)
	if err != nil {
		return out, err
	}
	paused, err := pause.Active(ctx, db)
	if err != nil {
		return out, err
	}
	for _, h := range list {
		c := hosts.Connection(h.Kind, h.Joined, h.JoinExpires, h.LastSeen, false, now)
		row := Host{ID: h.ID, Name: h.Name, Kind: h.Kind, Slots: slots(h), Busy: busy[h.ID], Paused: pause.Paused(paused, pause.Scope{Host: h.ID}),
			Online: c == hosts.ConnLocal || c == hosts.ConnOnline, Status: hosts.ConnText(c, false, h.LastSeen, h.JoinExpires, now)}
		if h.Kind == "remote" && !h.Joined && h.JoinExpires == 0 {
			row.Status = "还没接入"
		}
		out.Hosts = append(out.Hosts, row)
	}
	out.Workers, err = workers.List(ctx, db)
	if err != nil {
		return out, err
	}
	return out, nil
}

func quotaOf(ov quota.Overview) Quota {
	out := Quota{Accounts: []Account{}, Reserve: ov.Reserve}
	for _, l := range ov.Lines {
		out.Accounts = append(out.Accounts, account(l))
	}
	return out
}

func runningByHost(ctx context.Context, q store.Querier) (map[string]int, error) {
	rows, err := q.QueryContext(ctx, `SELECT host, count(*) FROM tasks WHERE status = 'running' AND host <> '' GROUP BY host LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var h string
		var n int
		if err := rows.Scan(&h, &n); err != nil {
			return nil, err
		}
		out[h] = n
	}
	return out, rows.Err()
}

// TaskDetail 是任务抽屉。
type TaskDetail struct {
	UsageText string         `json:"usage_text,omitempty"`
	Task      ledger.Task    `json:"task"`
	DeptName  string         `json:"dept_name"`
	Steps     []string       `json:"steps"`
	Step      int            `json:"step"`
	State     string         `json:"state"`
	Holder    string         `json:"holder"`
	Trace     *workers.Trace `json:"trace"`   // 最近一次拉起的经过（与 task log 同一份解析）；还没拉起过为空
	Live      bool           `json:"live"`    // 执行者正在干（执行这一步）
	RunAt     int64          `json:"run_at"`  // 最近一次拉起的时刻
	Parent    *Row           `json:"parent"`  // 挂在谁下面；没有为空
	Kids      []Row          `json:"kids"`    // 直接的子任务（按建立先后）
	Waits     []Row          `json:"waits"`   // 它要等的（依赖，含已结束的）
	Waiters   []Row          `json:"waiters"` // 在等它的
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
	p, err := ledger.PartiesOf(ctx, q, d.Task.ID)
	if err != nil || p.By == "" {
		return err
	}
	d.ByName = cmp.Or(names[p.By], p.By)
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
	t := d.Task
	row := func(id string) (Row, error) {
		x, err := ledger.Get(ctx, q, id)
		if err != nil {
			return Row{}, err
		}
		return looseRow(ctx, q, x, nil)
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
		r, err := rowOf(ctx, q, k, nil, kids[k.ID])
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
		return cmp.Or(names[h.Who], h.Who) + "：" + h.Text
	case "worker":
		return "执行者在做"
	}
	return h.Text
}

// ChoiceDetail 是选项单抽屉：agenda 的选项单加上部门名。
type ChoiceDetail struct {
	agenda.Choice
	DeptName string `json:"dept_name"`
}

func loadChoice(ctx context.Context, q store.Querier, id string) (ChoiceDetail, error) {
	c, err := agenda.GetChoice(ctx, q, id)
	if err != nil {
		return ChoiceDetail{}, err
	}
	out := ChoiceDetail{Choice: c}
	if c.Options == nil {
		out.Options = []agenda.Option{}
	}
	err = q.QueryRowContext(ctx, `SELECT name FROM departments WHERE id = ?`, c.Org).Scan(&out.DeptName)
	return out, err
}

func joinInts(list []int) string {
	parts := make([]string, len(list))
	for i, n := range list {
		parts[i] = strconv.Itoa(n)
	}
	return strings.Join(parts, "、")
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
