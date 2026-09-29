// Package ledger 是任务账本：任务、父子、依赖、状态机、就绪判定与汇总。
// 判定在 state.go、plan.go（纯函数）；本文件是落库。任务状态只经 Apply 改变，
// 其他包（dispatch、gates、merge、release、watch）一律调 Apply，不直接 UPDATE tasks.status。
package ledger

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

type Task struct {
	ID         string   `json:"id"`
	Parent     string   `json:"parent,omitempty"`
	Org        string   `json:"org,omitempty"`
	Skill      string   `json:"skill,omitempty"`
	Title      string   `json:"title"`
	Detail     string   `json:"detail,omitempty"`
	Status     Status   `json:"status"`
	Stage      Stage    `json:"stage,omitempty"`
	Priority   Priority `json:"priority"`
	Repo       string   `json:"repo,omitempty"`
	Dir        string   `json:"dir,omitempty"`    // 工作地点：本机文件夹，执行者在原地干（与 Repo 只有一个）
	Source     Source   `json:"source,omitempty"` // 草稿记的发现从哪来：user 用户纠正、org 组织发现
	Class      string   `json:"class,omitempty"`  // 发现按原因归的类
	Worker     string   `json:"worker,omitempty"`
	Host       string   `json:"host,omitempty"`
	PR         string   `json:"pr,omitempty"`
	CreatedAt  int64    `json:"created_at"`
	UpdatedAt  int64    `json:"updated_at"`
	FinishedAt *int64   `json:"finished_at,omitempty"`
}

const taskCols = `id, parent, department, skill, title, detail, status, stage, priority, repo, worker, host, pr,
	created_at, updated_at, finished_at`

// extraCols 是另存一张表的几列（工作地点在 task_dirs，来源与类在 task_findings，见 schema.sql），接在 taskCols 后面；
// t 是 tasks 在查询里的名字。
func extraCols(t string) string {
	return `, COALESCE((SELECT dir FROM task_dirs WHERE task = ` + t + `.id), ''),
	COALESCE((SELECT source FROM task_findings WHERE task = ` + t + `.id), ''),
	COALESCE((SELECT class FROM task_findings WHERE task = ` + t + `.id), '')`
}

type scanner interface{ Scan(dest ...any) error }

func scanTask(s scanner) (Task, error) {
	var t Task
	var parent, org, skill sql.NullString
	var finished sql.NullInt64
	err := s.Scan(&t.ID, &parent, &org, &skill, &t.Title, &t.Detail, &t.Status, &t.Stage, &t.Priority,
		&t.Repo, &t.Worker, &t.Host, &t.PR, &t.CreatedAt, &t.UpdatedAt, &finished, &t.Dir, &t.Source, &t.Class)
	t.Parent, t.Org, t.Skill = parent.String, org.String, skill.String
	if finished.Valid {
		t.FinishedAt = &finished.Int64
	}
	return t, err
}

// 字段上限（按字符数）。
const (
	maxTitle  = 200
	maxDetail = 20000
	maxNote   = 4000
	maxDeps   = 50
)

// NewTask 是 task add 的输入。
type NewTask struct {
	Title    string   `json:"title"`
	Detail   string   `json:"detail"`
	Parent   string   `json:"parent"`
	Org      string   `json:"org"`
	Skill    string   `json:"skill"`
	Priority Priority `json:"priority"`
	Repo     string   `json:"repo"`
	Dir      string   `json:"dir"`
	After    []string `json:"after"`
	// Owner 是处理人：结果事件要处理地投给他（u1、secretary 或 aN），缺省为派活人。
	Owner string `json:"owner"`
	// Draft：建成草稿（还没想清楚、条件还不够；不派活、不计时），缺省建成 todo。
	Draft bool `json:"draft"`
	// Source、Class：草稿记的发现从哪来、归哪一类（只给草稿）。
	Source Source `json:"source"`
	Class  string `json:"class"`
	// By 是派活人，缺省为建任务的身份；周期任务记建周期任务的人。不从请求体读。
	By string `json:"-"`
}

// Parties 是任务的派活人与处理人，记在 created 经历里。
type Parties struct {
	By    string `json:"by,omitempty"`
	Owner string `json:"owner,omitempty"`
}

func checkText(field, v string, limit int, required bool) error {
	if required && strings.TrimSpace(v) == "" {
		return api.Usage("--%s: 不能为空", field)
	}
	if n := utf8.RuneCountInString(v); n > limit {
		return api.Usage("--%s: 最多 %d 字，收到 %d 字", field, limit, n)
	}
	return nil
}

// checkPlace 核对仓库与工作地点（纯函数）：工作地点是本机文件夹的绝对路径，两者只给一个。文件夹在不在派活时才查
// （可能由前面的任务建出来）。
func checkPlace(repo, dir string) error {
	switch {
	case dir == "":
		return nil
	case !filepath.IsAbs(dir) || strings.ContainsAny(dir, "\r\n"):
		return api.Usage("--dir: 应为本机文件夹的绝对路径，收到 %q", dir)
	case repo != "":
		return api.Usage("--dir: 和仓库（%s）只能有一个：git 仓库用 --repo（建工作树），别的文件夹用 --dir（原地干）", repo)
	}
	return nil
}

// Assignee 纯判定：建好就要唤醒谁去拆活。处理人是负责人（aN）、不是建的人自己，任务没有仓库也没有工作地点、
// 不是草稿——意思是「交给这位负责人去拆」；返回这位负责人，否则返回空。
func Assignee(in NewTask, actor string) string {
	if in.Draft || in.Repo != "" || in.Dir != "" || in.Owner == actor || !api.IsRef(in.Owner, "a") {
		return ""
	}
	return in.Owner
}

// DeptRepo 纯判定：派活时任务该带上部门的哪个仓库（repos 是部门自己的仓库），不用补为空。任务没仓库也没工作地点、
// 部门恰有一个仓库才补——多个时分不出是哪个；只补能派的（按 Transition），在跑、在交付的不动，免得中途换了交付方式。
func DeptRepo(t Task, repos []string) string {
	if t.Repo != "" || t.Dir != "" || len(repos) != 1 {
		return ""
	}
	if _, err := Transition(State{t.Status, t.Stage}, Event{Kind: Enqueue}); err != nil {
		return ""
	}
	return repos[0]
}

// UseDeptRepo 是 task run 入口用的：按 DeptRepo 给任务写上部门的仓库。草稿、后来才定部门的、交给负责人的，
// 派出去时都在这一处补上；运行时自己派的（审阅、周期任务）不经这里，照旧没有仓库。
func UseDeptRepo(ctx context.Context, db *store.DB, id, actor string) error {
	t, err := Get(ctx, db, id)
	if err != nil || t.Org == "" {
		return err
	}
	d, err := org.Get(ctx, db, t.Org)
	if err != nil {
		return err
	}
	if repo := DeptRepo(t, d.Repos); repo != "" {
		_, err = Edit(ctx, db, id, Patch{Repo: &repo}, actor)
	}
	return err
}

// setDir 写工作地点：空为没有。
func setDir(ctx context.Context, tx *sql.Tx, id, dir string) error {
	if dir == "" {
		_, err := tx.ExecContext(ctx, `DELETE FROM task_dirs WHERE task = ?`, id)
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO task_dirs (task, dir) VALUES (?, ?)
		ON CONFLICT (task) DO UPDATE SET dir = excluded.dir`, id, filepath.Clean(dir))
	return err
}

func checkPriority(p Priority) error {
	if p.Rank() < 0 {
		return api.Usage("--priority: 应为 urgent（紧急）、fix（修复）、normal（普通）、idle（闲时），收到 %q", p)
	}
	return nil
}

func exists(ctx context.Context, q store.Querier, table, id string) (bool, error) {
	var one int
	err := q.QueryRowContext(ctx, `SELECT 1 FROM `+table+` WHERE id = ?`, id).Scan(&one)
	if store.IsNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

func mustExist(ctx context.Context, q store.Querier, table, prefix, field, id string) error {
	if !api.IsRef(id, prefix) {
		return api.Usage("--%s: 应为 %sN 形式的短号，收到 %q", field, prefix, id)
	}
	ok, err := exists(ctx, q, table, id)
	if err != nil {
		return err
	}
	if !ok {
		return api.NotFound("--%s: %s 不存在", field, id)
	}
	return nil
}

// mustSkill：挂的技能要已登记（skills 表归 org；这里只查有没有，与 mustExist 查部门一样）。
func mustSkill(ctx context.Context, q store.Querier, name string) error {
	var n int
	if err := q.QueryRowContext(ctx, `SELECT count(*) FROM skills WHERE name = ?`, name).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return api.NotFound("--skill: 技能 %s 不存在", name).WithNext("atrium skill ls")
	}
	return nil
}

// Add 建一件 todo 任务（Draft 时建成草稿，受草稿上限）。没给部门时沿用父任务的部门。
func Add(ctx context.Context, db *store.DB, in NewTask, actor string) (Task, error) {
	if in.Priority == "" {
		in.Priority = Normal
	}
	if err := checkText("title", in.Title, maxTitle, true); err != nil {
		return Task{}, err
	}
	if err := checkText("detail", in.Detail, maxDetail, false); err != nil {
		return Task{}, err
	}
	if err := checkPriority(in.Priority); err != nil {
		return Task{}, err
	}
	if len(in.After) > maxDeps {
		return Task{}, api.Usage("--after: 最多 %d 个依赖", maxDeps)
	}
	if err := checkPlace(in.Repo, in.Dir); err != nil {
		return Task{}, err
	}
	if in.Class = strings.TrimSpace(in.Class); !in.Draft && (in.Source != "" || in.Class != "") {
		return Task{}, api.Usage("--source、--class: 只给草稿（--draft）；已有任务改用 atrium task set tN --source … --class …")
	}
	if err := checkFinding(in.Source, in.Class); err != nil {
		return Task{}, err
	}
	var id string
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		if in.Parent != "" {
			if err := mustExist(ctx, tx, "tasks", "t", "parent", in.Parent); err != nil {
				return err
			}
			if in.Org == "" {
				p, err := Get(ctx, tx, in.Parent)
				if err != nil {
					return err
				}
				in.Org = p.Org
			}
		}
		if in.Org != "" {
			if err := mustExist(ctx, tx, "departments", "o", "org", in.Org); err != nil {
				return err
			}
		}
		if in.Skill != "" {
			if err := mustSkill(ctx, tx, in.Skill); err != nil {
				return err
			}
		}
		for _, d := range in.After {
			if err := mustExist(ctx, tx, "tasks", "t", "after", d); err != nil {
				return err
			}
		}
		if in.Owner != "" {
			if ok, err := exists(ctx, tx, "identities", in.Owner); err != nil {
				return err
			} else if !ok {
				return api.NotFound("--owner: %s 不存在（应为 u1、secretary 或已登记的 aN）", in.Owner).WithNext("atrium leader ls")
			}
		}
		assignee := Assignee(in, actor)
		if assignee != "" && in.Org == "" {
			// 交给负责人的任务落到它负责的部门，它才动得了；负责多个部门时要写明哪个。
			lm, err := org.LeaderMap(ctx, tx)
			if err != nil {
				return err
			}
			led := org.Led(lm, assignee)
			if len(led) != 1 {
				return api.Usage("--org: 交给 %s 去拆的任务要写归属部门（它负责 %d 个部门：%s）", assignee, len(led), strings.Join(led, "、"))
			}
			in.Org = led[0]
		}
		if in.Draft {
			if err := roomForDraft(ctx, tx); err != nil {
				return err
			}
		}
		var err error
		if id, err = insert(ctx, tx, in, actor); err != nil {
			return err
		}
		if assignee == "" {
			return nil
		}
		return events.Emit(ctx, tx, events.Event{Kind: events.TaskAssigned, Task: id, Dept: in.Org, Target: assignee,
			Body: map[string]any{"title": strings.TrimSpace(in.Title)}, By: actor})
	})
	if err != nil {
		return Task{}, err
	}
	changed.broadcast()
	return Get(ctx, db, id)
}

// insert 在事务里写一件任务（已核对过的 in）：任务行、工作地点、来源与类、依赖、建立记录。返回短号。
func insert(ctx context.Context, tx *sql.Tx, in NewTask, actor string) (string, error) {
	status := Todo
	if in.Draft {
		status = Draft
	}
	id, err := store.NextID(ctx, tx, "t")
	if err != nil {
		return "", err
	}
	now := store.Now()
	if _, err := tx.ExecContext(ctx, `INSERT INTO tasks (id, parent, department, skill, title, detail, status,
		priority, repo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, store.Null(in.Parent), store.Null(in.Org), store.Null(in.Skill), strings.TrimSpace(in.Title),
		in.Detail, status, in.Priority, in.Repo, now, now); err != nil {
		return "", err
	}
	if err := setDir(ctx, tx, id, in.Dir); err != nil {
		return "", err
	}
	if err := setFinding(ctx, tx, id, in.Source, in.Class); err != nil {
		return "", err
	}
	for _, d := range in.After {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO task_deps (task, depends_on) VALUES (?, ?)`, id, d); err != nil {
			return "", err
		}
	}
	parties := ""
	if in.By != "" || in.Owner != "" {
		raw, _ := json.Marshal(Parties{By: in.By, Owner: in.Owner})
		parties = string(raw)
	}
	return id, Record(ctx, tx, id, "created", actor, parties)
}

// Get 读一件任务；不存在返回 404 错误。
func Get(ctx context.Context, q store.Querier, id string) (Task, error) {
	t, err := scanTask(q.QueryRowContext(ctx, `SELECT `+taskCols+extraCols("tasks")+` FROM tasks WHERE id = ?`, id))
	if store.IsNotFound(err) {
		return Task{}, api.NotFound("任务 %s 不存在", id).WithNext("atrium task ls")
	}
	return t, err
}

// Filter 是 task ls 的条件；Status 为空时列没结束的（不含 done、cancelled）。
type Filter struct {
	Status []Status
	Org    string
	Parent string
	Top    bool // 只列没有父任务的
	Limit  int
}

func List(ctx context.Context, q store.Querier, f Filter) ([]Task, error) {
	var where []string
	var args []any
	if len(f.Status) > 0 {
		marks := make([]string, len(f.Status))
		for i, s := range f.Status {
			marks[i] = "?"
			args = append(args, s)
		}
		where = append(where, "status IN ("+strings.Join(marks, ",")+")")
	} else {
		where = append(where, "status NOT IN ('done', 'cancelled')")
	}
	if f.Org != "" {
		where, args = append(where, "department = ?"), append(args, f.Org)
	}
	if f.Parent != "" {
		where, args = append(where, "parent = ?"), append(args, f.Parent)
	}
	if f.Top {
		where = append(where, "parent IS NULL")
	}
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 50
	}
	args = append(args, f.Limit)
	rows, err := q.QueryContext(ctx, `SELECT `+taskCols+extraCols("tasks")+` FROM tasks WHERE `+strings.Join(where, " AND ")+
		` ORDER BY created_at DESC, id DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	return collect(rows)
}

func collect(rows *sql.Rows) ([]Task, error) {
	defer rows.Close()
	out := []Task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Patch 是 task set 能改的描述字段；nil 表示不改。After 给了就整体替换依赖。
type Patch struct {
	Title    *string   `json:"title,omitempty"`
	Detail   *string   `json:"detail,omitempty"`
	Priority *Priority `json:"priority,omitempty"`
	Org      *string   `json:"org,omitempty"`
	Skill    *string   `json:"skill,omitempty"`
	Repo     *string   `json:"repo,omitempty"`
	Dir      *string   `json:"dir,omitempty"`
	After    *[]string `json:"after,omitempty"`
	Source   *Source   `json:"source,omitempty"`
	Class    *string   `json:"class,omitempty"`
}

func (p Patch) empty() bool {
	return p.Title == nil && p.Detail == nil && p.Priority == nil && p.Org == nil && p.Skill == nil &&
		p.Repo == nil && p.Dir == nil && p.After == nil && p.Source == nil && p.Class == nil
}

// Edit 改描述字段与依赖（状态用 Apply）。
func Edit(ctx context.Context, db *store.DB, id string, p Patch, actor string) (Task, error) {
	if p.empty() {
		return Task{}, api.Usage("没有要改的字段")
	}
	if p.Title != nil {
		if err := checkText("title", *p.Title, maxTitle, true); err != nil {
			return Task{}, err
		}
	}
	if p.Detail != nil {
		if err := checkText("detail", *p.Detail, maxDetail, false); err != nil {
			return Task{}, err
		}
	}
	if p.Priority != nil {
		if err := checkPriority(*p.Priority); err != nil {
			return Task{}, err
		}
	}
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		cur, err := Get(ctx, tx, id)
		if err != nil {
			return err
		}
		repo, dir := cur.Repo, cur.Dir
		if p.Repo != nil {
			repo = *p.Repo
		}
		if p.Dir != nil {
			dir = *p.Dir
		}
		if err := checkPlace(repo, dir); err != nil {
			return err
		}
		if p.Dir != nil {
			if err := setDir(ctx, tx, id, dir); err != nil {
				return err
			}
		}
		if p.Source != nil || p.Class != nil {
			src, class := cur.Source, cur.Class
			if p.Source != nil {
				src = *p.Source
			}
			if p.Class != nil {
				class = strings.TrimSpace(*p.Class)
			}
			if err := checkFinding(src, class); err != nil {
				return err
			}
			if err := setFinding(ctx, tx, id, src, class); err != nil {
				return err
			}
		}
		sets, args := []string{}, []any{}
		add := func(col string, v any) { sets, args = append(sets, col+" = ?"), append(args, v) }
		if p.Title != nil {
			add("title", strings.TrimSpace(*p.Title))
		}
		if p.Detail != nil {
			add("detail", *p.Detail)
		}
		if p.Priority != nil {
			add("priority", *p.Priority)
		}
		if p.Org != nil {
			if *p.Org != "" {
				if err := mustExist(ctx, tx, "departments", "o", "org", *p.Org); err != nil {
					return err
				}
			}
			add("department", store.Null(*p.Org))
		}
		if p.Skill != nil {
			if *p.Skill != "" {
				if err := mustSkill(ctx, tx, *p.Skill); err != nil {
					return err
				}
			}
			add("skill", store.Null(*p.Skill))
		}
		if p.Repo != nil {
			add("repo", *p.Repo)
		}
		add("updated_at", store.Now())
		args = append(args, id)
		if _, err := tx.ExecContext(ctx, `UPDATE tasks SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
			return err
		}
		if p.After != nil {
			if err := replaceDeps(ctx, tx, id, *p.After); err != nil {
				return err
			}
		}
		body, _ := json.Marshal(p)
		return Record(ctx, tx, id, "edited", actor, string(body))
	})
	if err != nil {
		return Task{}, err
	}
	changed.broadcast()
	return Get(ctx, db, id)
}

func replaceDeps(ctx context.Context, tx *sql.Tx, id string, after []string) error {
	if len(after) > maxDeps {
		return api.Usage("--after: 最多 %d 个依赖", maxDeps)
	}
	for _, d := range after {
		if d == id {
			return api.Usage("--after: 任务不能依赖自己")
		}
		if err := mustExist(ctx, tx, "tasks", "t", "after", d); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM task_deps WHERE task = ?`, id); err != nil {
		return err
	}
	for _, d := range after {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO task_deps (task, depends_on) VALUES (?, ?)`, id, d); err != nil {
			return err
		}
	}
	edges, err := reachableEdges(ctx, tx, id)
	if err != nil {
		return err
	}
	if cycle := FindCycle(edges); cycle != nil {
		return api.Usage("--after: 依赖成环：%s", strings.Join(cycle, " → "))
	}
	return nil
}

// reachableEdges 取从 id 出发沿依赖能走到的全部边（有上限）。
func reachableEdges(ctx context.Context, q store.Querier, id string) (map[string][]string, error) {
	rows, err := q.QueryContext(ctx, `WITH RECURSIVE r(t) AS (SELECT ? UNION SELECT d.depends_on FROM task_deps d JOIN r ON d.task = r.t)
		SELECT d.task, d.depends_on FROM task_deps d JOIN r ON d.task = r.t LIMIT 10000`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	edges := map[string][]string{}
	for rows.Next() {
		var a, b string
		if err := rows.Scan(&a, &b); err != nil {
			return nil, err
		}
		edges[a] = append(edges[a], b)
	}
	return edges, rows.Err()
}

// Apply 是改任务状态的唯一入口：按 Transition 判定、落库、记经历、发事件、唤醒等待者。
// note 记进经历（可空）。
func Apply(ctx context.Context, db *store.DB, id string, ev Event, actor, note string) (Task, error) {
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		t, err := Get(ctx, tx, id)
		if err != nil {
			return err
		}
		if ev.Kind == Bounce {
			if ev.Bounces, err = Bounces(ctx, tx, id); err != nil {
				return err
			}
		}
		next, err := Transition(State{t.Status, t.Stage}, ev)
		if err != nil {
			return api.Conflict("%s：%v", id, err)
		}
		if next.Status == Draft && t.Status != Draft {
			if err := roomForDraft(ctx, tx); err != nil {
				return err
			}
		}
		now := store.Now()
		var finished any
		if next.Status.Finished() {
			finished = now
		}
		if _, err := tx.ExecContext(ctx, `UPDATE tasks SET status = ?, stage = ?, updated_at = ?, finished_at = ? WHERE id = ?`,
			next.Status, next.Stage, now, finished, id); err != nil {
			return err
		}
		body, _ := json.Marshal(map[string]any{"from": State{t.Status, t.Stage}, "to": next, "note": note})
		if err := Record(ctx, tx, id, string(ev.Kind), actor, string(body)); err != nil {
			return err
		}
		if c, ok := Correction(t, next, ev.Kind, actor, note); ok {
			// 用户亲手的退回、取消不因草稿满了被拒：满了由巡检的上限提醒去腾。
			if _, err := insert(ctx, tx, c, actor); err != nil {
				return err
			}
		}
		accepting := next.Stage == StageAccept && t.Stage != StageAccept
		if next.Status == t.Status && ev.Kind != Land && !accepting {
			return nil // 只有状态变化、落地推进一步（如已合入等发版）与转入等验收发事件
		}
		p, err := PartiesOf(ctx, tx, id)
		if err != nil {
			return err
		}
		payload := map[string]any{"from": t.Status, "to": next.Status, "stage": next.Stage, "title": t.Title, "event": ev.Kind, "by": actor}
		if note != "" {
			payload["note"] = clip(note, 500)
		}
		if accepting {
			payload["accept_by"] = ev.AcceptBy
			payload["next"] = "atrium task accept " + id
		}
		return events.EmitTask(ctx, tx, p.Owner, events.Event{Kind: events.TaskStatus, Task: id, Dept: t.Org, Body: payload, By: actor})
	})
	if err != nil {
		return Task{}, err
	}
	changed.broadcast()
	return Get(ctx, db, id)
}

// PartiesOf 读任务的派活人与处理人：派活人没另记就是建它的身份（u1、secretary、aN，或 gates 这类运行时），
// 处理人没指定就是派活人。没有建立记录（不经 Add 写进库的）两者都为空，按运行时建的算。
func PartiesOf(ctx context.Context, q store.Querier, id string) (Parties, error) {
	var actor, body string
	err := q.QueryRowContext(ctx, `SELECT actor, body FROM task_events WHERE task = ? AND kind = 'created' ORDER BY id LIMIT 1`, id).
		Scan(&actor, &body)
	if store.IsNotFound(err) {
		return Parties{}, nil
	}
	if err != nil {
		return Parties{}, err
	}
	var p Parties
	if body != "" {
		if err := json.Unmarshal([]byte(body), &p); err != nil {
			return Parties{}, fmt.Errorf("%s 的建立记录坏了：%w", id, err)
		}
	}
	if p.By == "" {
		p.By = actor
	}
	if p.Owner == "" {
		p.Owner = p.By
	}
	return p, nil
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// Bounces 数这件任务最近一次人工改状态（task set --status、task merge）之后被交回了几次。
func Bounces(ctx context.Context, q store.Querier, id string) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT count(*) FROM task_events WHERE task = ? AND kind = 'bounce'
		AND id > COALESCE((SELECT max(id) FROM task_events WHERE task = ? AND kind IN ('set', 'deliver')), 0)`, id, id).Scan(&n)
	return n, err
}

// Facts 是运行时查到并记在任务行上的事实（执行者、机器、PR）；nil 表示不改。
type Facts struct {
	Worker *string
	Host   *string
	PR     *string
}

// SetFacts 给 dispatch、gates 记执行者、机器与 PR。
func SetFacts(ctx context.Context, db *store.DB, id string, f Facts, actor string) error {
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := Get(ctx, tx, id); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE tasks SET worker = COALESCE(?, worker), host = COALESCE(?, host),
			pr = COALESCE(?, pr), updated_at = ? WHERE id = ?`, f.Worker, f.Host, f.PR, store.Now(), id)
		if err != nil {
			return err
		}
		body, _ := json.Marshal(f)
		return Record(ctx, tx, id, "facts", actor, string(body))
	})
	if err == nil {
		changed.broadcast()
	}
	return err
}

// Record 追加一条任务经历。其他包记关卡结论、交回原因等也用它（kind 自定，如 "gate"、"review"）。
func Record(ctx context.Context, q store.Querier, id, kind, actor, body string) error {
	_, err := q.ExecContext(ctx, `INSERT INTO task_events (task, at, kind, actor, body) VALUES (?, ?, ?, ?, ?)`,
		id, store.Now(), kind, actor, body)
	return err
}

// Note 是 task note：给任务加一条备注。
func Note(ctx context.Context, db *store.DB, id, actor, text string) error {
	if err := checkText("text", text, maxNote, true); err != nil {
		return err
	}
	return db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := Get(ctx, tx, id); err != nil {
			return err
		}
		return Record(ctx, tx, id, "note", actor, text)
	})
}

type TaskEvent struct {
	ID    int64  `json:"id"`
	At    int64  `json:"at"`
	Kind  string `json:"kind"`
	Actor string `json:"actor"`
	Body  string `json:"body,omitempty"`
}

// History 取最近 limit 条经历（按时间正序）。
func History(ctx context.Context, q store.Querier, id string, limit int) ([]TaskEvent, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, at, kind, actor, body FROM
		(SELECT * FROM task_events WHERE task = ? ORDER BY id DESC LIMIT ?) ORDER BY id`, id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TaskEvent{}
	for rows.Next() {
		var e TaskEvent
		if err := rows.Scan(&e.ID, &e.At, &e.Kind, &e.Actor, &e.Body); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// Deps 取一件任务的依赖与各自状态。
func Deps(ctx context.Context, q store.Querier, id string) ([]DepState, error) {
	rows, err := q.QueryContext(ctx, `SELECT t.id, t.status FROM task_deps d JOIN tasks t ON t.id = d.depends_on
		WHERE d.task = ? ORDER BY t.created_at LIMIT ?`, id, maxDeps)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DepState{}
	for rows.Next() {
		var d DepState
		if err := rows.Scan(&d.ID, &d.Status); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// Children 数一件任务的直接子任务：还没结束的与全部（拆开在做的父任务靠它判断在做还是等收尾）。
func Children(ctx context.Context, q store.Querier, id string) (open, total int, err error) {
	err = q.QueryRowContext(ctx, `SELECT COALESCE(sum(status NOT IN ('done', 'failed', 'cancelled')), 0), count(*)
		FROM tasks WHERE parent = ?`, id).Scan(&open, &total)
	return open, total, err
}

// maxSubtree 是一棵任务树一次读出的上限。
const maxSubtree = 2000

// Subtree 取 root 及全部子孙（root 在第一个）。
func Subtree(ctx context.Context, q store.Querier, root string) ([]Task, error) {
	rows, err := q.QueryContext(ctx, `WITH RECURSIVE r(id, depth) AS (SELECT ?, 0 UNION ALL
		SELECT t.id, r.depth + 1 FROM tasks t JOIN r ON t.parent = r.id)
		SELECT `+prefixed("t.", taskCols)+extraCols("t")+` FROM r JOIN tasks t ON t.id = r.id ORDER BY r.depth, t.created_at LIMIT ?`,
		root, maxSubtree)
	if err != nil {
		return nil, err
	}
	out, err := collect(rows)
	if err == nil && len(out) == 0 {
		return nil, api.NotFound("任务 %s 不存在", root)
	}
	return out, err
}

// SubtreeDeps 取 root 及全部子孙的依赖：任务 → 它依赖的任务与状态（依赖可以在树外）。
func SubtreeDeps(ctx context.Context, q store.Querier, root string) (map[string][]DepState, error) {
	rows, err := q.QueryContext(ctx, `WITH RECURSIVE r(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN r ON t.parent = r.id)
		SELECT d.task, t.id, t.status FROM r JOIN task_deps d ON d.task = r.id JOIN tasks t ON t.id = d.depends_on
		ORDER BY t.created_at LIMIT ?`, root, maxSubtree*maxDeps)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]DepState{}
	for rows.Next() {
		var task string
		var d DepState
		if err := rows.Scan(&task, &d.ID, &d.Status); err != nil {
			return nil, err
		}
		out[task] = append(out[task], d)
	}
	return out, rows.Err()
}

func prefixed(p, cols string) string {
	parts := strings.Split(cols, ",")
	for i, c := range parts {
		parts[i] = p + strings.TrimSpace(c)
	}
	return strings.Join(parts, ", ")
}

// notifier 在任务有任何写入后唤醒全部等待者（task wait 长轮询、第二波的派活循环）。
type notifier struct {
	mu sync.Mutex
	ch chan struct{}
}

func (n *notifier) wait() <-chan struct{} {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.ch
}

func (n *notifier) broadcast() {
	n.mu.Lock()
	defer n.mu.Unlock()
	close(n.ch)
	n.ch = make(chan struct{})
}

var changed = &notifier{ch: make(chan struct{})}

// Changed 返回一个通道：本进程里任何任务写入后它会被关闭。先取通道再读库，避免漏掉唤醒。
func Changed() <-chan struct{} { return changed.wait() }

// roomForDraft：草稿满了（上限表 drafts）拒绝再加。
func roomForDraft(ctx context.Context, q store.Querier) error {
	var n int
	if err := q.QueryRowContext(ctx, `SELECT count(*) FROM tasks WHERE status = 'draft'`).Scan(&n); err != nil {
		return err
	}
	if n >= org.MaxDrafts {
		return org.Full("drafts", "", n)
	}
	return nil
}
