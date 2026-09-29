package agenda

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 周期任务 sN：到点在部门下生成一件普通任务并按 task run 派发；上一轮没结束就跳过记一笔；停机错过只补一轮。

// Enqueue 把一件任务送进派活队列（即 task run）。由 dispatch 在装配时接上：
//
//	agenda.Enqueue = func(ctx context.Context, env *app.Env, task, actor string) error { … }
//
// 没接上时周期任务照样生成任务，但那一轮记「派活未接入」并报错。
var Enqueue func(ctx context.Context, env *app.Env, task, actor string) error

var Kinds = map[string]string{"task": "自定义", "patrol": "体验巡检", "research": "调研"}

// DispatchFailed 是一轮派活失败时记在 last_note 里的字样；网页据此把这一轮标红。
const DispatchFailed = "派活失败"

const (
	maxScheduleTitle  = 150
	maxScheduleDetail = 8000
	dueBatch          = 100
	recentChoices     = 5 // 调研轮附最近几份拍过板的选项单
)

// kindNote 是按种类附在生成任务详述末尾的做法。
var kindNote = map[string]string{
	"patrol": "这是体验巡检：按真实用法把主路径走一遍，记下卡住、看不懂、出错的地方；能修的开 PR，修不了的写进任务备注。",
	"research": "这是调研：调研完在工作目录根写 " + ChoiceFile + "，交付时登记成选项单交用户拍板。格式：\n" +
		`{"title": "…", "options": [{"title": "…", "gain": "能多做到什么", "why_now": "为什么现在", "cost": "代价", ` +
		`"if_not": "不做会怎样", "evidence": "依据", "org": "oN"}], "recommend": [1], "reason": "推荐理由"}` + "\n" +
		"3–5 项，每项五栏都要写；org 是这一项归哪个部门（不写归本部门），选中后交给那里的负责人设计、拆活；recommend 是推荐第几项（1 起）。",
}

type Schedule struct {
	ID        string `json:"id"`
	Org       string `json:"org"`
	Kind      string `json:"kind"`
	Every     string `json:"every"`
	EveryMs   int64  `json:"every_ms"`
	At        string `json:"at,omitempty"`
	Title     string `json:"title"`
	Detail    string `json:"detail,omitempty"`
	Skill     string `json:"skill,omitempty"`
	NextAt    int64  `json:"next_at"`
	LastRunAt *int64 `json:"last_run_at,omitempty"`
	LastTask  string `json:"last_task,omitempty"`
	Skips     int    `json:"skips"`
	LastNote  string `json:"last_note,omitempty"`
	CreatedBy string `json:"created_by"`
	CreatedAt int64  `json:"created_at"`
	atMinute  *int
}

type NewSchedule struct {
	Org    string `json:"org"`
	Title  string `json:"title"`
	Kind   string `json:"kind"`
	Every  string `json:"every"`
	At     string `json:"at"`
	Detail string `json:"detail"`
	Skill  string `json:"skill"`
}

const scheduleCols = `id, department, kind, every_ms, at_minute, title, detail, skill, next_at, last_run_at,
	COALESCE(last_task, ''), skips, last_note, created_by, created_at`

func scanSchedule(s interface{ Scan(...any) error }) (Schedule, error) {
	var x Schedule
	var at, last sql.NullInt64
	err := s.Scan(&x.ID, &x.Org, &x.Kind, &x.EveryMs, &at, &x.Title, &x.Detail, &x.Skill, &x.NextAt, &last,
		&x.LastTask, &x.Skips, &x.LastNote, &x.CreatedBy, &x.CreatedAt)
	x.Every = EveryText(x.EveryMs)
	if at.Valid {
		m := int(at.Int64)
		x.atMinute, x.At = &m, AtText(m)
	}
	if last.Valid {
		x.LastRunAt = &last.Int64
	}
	return x, err
}

func GetSchedule(ctx context.Context, q store.Querier, id string) (Schedule, error) {
	x, err := scanSchedule(q.QueryRowContext(ctx, `SELECT `+scheduleCols+` FROM schedules WHERE id = ?`, id))
	if store.IsNotFound(err) {
		return Schedule{}, api.NotFound("周期任务 %s 不存在", id).WithNext("atrium schedule ls")
	}
	return x, err
}

func Schedules(ctx context.Context, q store.Querier, dept string) ([]Schedule, error) {
	query, args := `SELECT `+scheduleCols+` FROM schedules ORDER BY department, id LIMIT ?`, []any{org.MaxDepts * org.MaxSchedules}
	if dept != "" {
		query, args = `SELECT `+scheduleCols+` FROM schedules WHERE department = ? ORDER BY id LIMIT ?`, []any{dept, org.MaxSchedules}
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Schedule{}
	for rows.Next() {
		x, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// AddSchedule 建一条周期任务；第一轮按 FirstDue。
func AddSchedule(ctx context.Context, db *store.DB, data string, in NewSchedule, actor string, now int64, loc *time.Location) (Schedule, error) {
	if in.Kind == "" {
		in.Kind = "task"
	}
	if _, ok := Kinds[in.Kind]; !ok {
		return Schedule{}, api.Usage("--kind: 应为 task（自定义）、patrol（体验巡检）或 research（调研），收到 %q", in.Kind)
	}
	if err := need("--title", in.Title, maxScheduleTitle); err != nil {
		return Schedule{}, err
	}
	if n := len([]rune(in.Detail)); n > maxScheduleDetail {
		return Schedule{}, api.Usage("--detail: 最多 %d 字，收到 %d 字", maxScheduleDetail, n)
	}
	every, err := ParseEvery(in.Every)
	if err != nil {
		return Schedule{}, err
	}
	var at *int
	if in.At != "" {
		m, err := ParseAt(in.At, every)
		if err != nil {
			return Schedule{}, err
		}
		at = &m
	}
	var id string
	err = db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := org.Get(ctx, tx, in.Org); err != nil {
			return err
		}
		if in.Skill != "" {
			if _, err := org.GetSkill(ctx, tx, data, in.Skill); err != nil {
				return err
			}
		}
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM schedules WHERE department = ?`, in.Org).Scan(&n); err != nil {
			return err
		}
		if n >= org.MaxSchedules {
			return org.Full("schedules", in.Org, n)
		}
		var err error
		if id, err = store.NextID(ctx, tx, "s"); err != nil {
			return err
		}
		var atCol any
		if at != nil {
			atCol = *at
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO schedules (id, department, kind, every_ms, at_minute, title, detail, skill, next_at,
			created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, in.Org, in.Kind, every, atCol,
			strings.TrimSpace(in.Title), in.Detail, in.Skill, FirstDue(now, every, at, loc), actor, now)
		return err
	})
	if err != nil {
		return Schedule{}, err
	}
	wake()
	return GetSchedule(ctx, db, id)
}

func RemoveSchedule(ctx context.Context, db *store.DB, id string) (Schedule, error) {
	x, err := GetSchedule(ctx, db, id)
	if err != nil {
		return Schedule{}, err
	}
	_, err = db.ExecContext(ctx, `DELETE FROM schedules WHERE id = ?`, id)
	return x, err
}

// Rounds 是周期任务最近生成的 n 轮任务（created 经历的 actor 是 sN，含手动生成的），新的在前。
func Rounds(ctx context.Context, q store.Querier, id string, n int) ([]ledger.Task, error) {
	rows, err := q.QueryContext(ctx, `SELECT task FROM task_events WHERE kind = 'created' AND actor = ? ORDER BY id DESC LIMIT ?`, id, n)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]ledger.Task, 0, len(ids))
	for _, t := range ids {
		x, err := ledger.Get(ctx, q, t)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, nil
}

// openRound 是上一轮还没结束的任务；没有为空。
func openRound(ctx context.Context, q store.Querier, x Schedule) (string, error) {
	if x.LastTask == "" {
		return "", nil
	}
	t, err := ledger.Get(ctx, q, x.LastTask)
	if err != nil {
		return "", err
	}
	if OpenStatus(string(t.Status)) {
		return t.ID, nil
	}
	return "", nil
}

// RoundTask 纯函数：一轮生成的任务的标题与详述。unpicked 是本部门最近几份选项单没选的（调研轮才有）。
func RoundTask(x Schedule, unpicked []string, now int64, loc *time.Location) (title, detail string) {
	title = fmt.Sprintf("%s（%s）", x.Title, time.UnixMilli(now).In(loc).Format("01-02"))
	parts := []string{}
	if x.Detail != "" {
		parts = append(parts, x.Detail)
	}
	if n := kindNote[x.Kind]; n != "" {
		parts = append(parts, n)
	}
	if len(unpicked) > 0 {
		parts = append(parts, "最近几份选项单里用户没选的（别原样再提；要再提，写清什么变了）：\n- "+strings.Join(unpicked, "\n- "))
	}
	parts = append(parts, fmt.Sprintf("（周期任务 %s 每 %s 生成的一轮）", x.ID, x.Every))
	return title, strings.Join(parts, "\n\n")
}

// recentUnpicked 是部门最近几份拍过板的选项单里没选的，每份一行。
func recentUnpicked(ctx context.Context, q store.Querier, dept string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT id FROM choices WHERE department = ? AND status != 'open'
		ORDER BY decided_at DESC, id DESC LIMIT ?`, dept, recentChoices)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var out []string
	for _, id := range ids {
		c, err := GetChoice(ctx, q, id)
		if err != nil {
			return nil, err
		}
		if s := Unpicked(c); s != "" {
			out = append(out, s)
		}
	}
	return out, nil
}

// runRound 生成一轮：建任务、送进派活队列、记在周期任务上。next 为 0 表示不改下一轮（手动 run）。
func runRound(ctx context.Context, env *app.Env, x Schedule, next int64, note string, now int64, loc *time.Location) (ledger.Task, error) {
	var unpicked []string
	if x.Kind == "research" {
		var err error
		if unpicked, err = recentUnpicked(ctx, env.DB, x.Org); err != nil {
			return ledger.Task{}, err
		}
	}
	title, detail := RoundTask(x, unpicked, now, loc)
	t, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: title, Detail: detail, Org: x.Org, Skill: x.Skill, By: x.CreatedBy}, x.ID)
	if err != nil {
		return ledger.Task{}, err
	}
	if next == 0 {
		next = x.NextAt
	}
	var runErr error
	if Enqueue == nil {
		runErr = fmt.Errorf("派活未接入：dispatch 没有设置 agenda.Enqueue，%s 留在 todo", t.ID)
	} else {
		runErr = Enqueue(ctx, env, t.ID, x.ID)
	}
	if runErr != nil {
		note = strings.TrimSpace(note + " " + DispatchFailed + "：" + runErr.Error())
	}
	if _, err := env.DB.ExecContext(ctx, `UPDATE schedules SET last_task = ?, last_run_at = ?, next_at = ?, last_note = ? WHERE id = ?`,
		t.ID, now, next, note, x.ID); err != nil {
		return t, err
	}
	return t, runErr
}

// RunNow 是 schedule run：马上生成一轮（不改下一轮的时间）；上一轮没结束就拒绝。
func RunNow(ctx context.Context, env *app.Env, id string, loc *time.Location) (ledger.Task, error) {
	x, err := GetSchedule(ctx, env.DB, id)
	if err != nil {
		return ledger.Task{}, err
	}
	open, err := openRound(ctx, env.DB, x)
	if err != nil {
		return ledger.Task{}, err
	}
	if open != "" {
		return ledger.Task{}, api.Conflict("%s 上一轮 %s 还没结束", id, open).WithNext("atrium task show " + open)
	}
	now := store.Now()
	return runRound(ctx, env, x, 0, "手动生成一轮", now, loc)
}

// Tick 巡检一次到点的周期任务。暂停范围内的不动（下一轮时间不变，恢复后只补一轮）。
func Tick(ctx context.Context, env *app.Env, now int64, loc *time.Location) error {
	rows, err := env.DB.QueryContext(ctx, `SELECT `+scheduleCols+` FROM schedules WHERE next_at <= ? ORDER BY next_at LIMIT ?`, now, dueBatch)
	if err != nil {
		return err
	}
	var due []Schedule
	for rows.Next() {
		x, err := scanSchedule(rows)
		if err != nil {
			rows.Close()
			return err
		}
		due = append(due, x)
	}
	rows.Close()
	for _, x := range due {
		chain, err := org.Ancestors(ctx, env.DB, x.Org)
		if err != nil {
			return err
		}
		if paused, err := env.Pause.Paused(ctx, pause.Scope{Orgs: chain}); err != nil || paused {
			if err != nil {
				return err
			}
			continue
		}
		open, err := openRound(ctx, env.DB, x)
		if err != nil {
			return err
		}
		v := Due(x.NextAt, x.EveryMs, x.atMinute, open, now, loc)
		missed := ""
		if v.Missed > 0 {
			missed = fmt.Sprintf("（停机错过 %d 轮，只补这一轮）", v.Missed)
		}
		day := time.UnixMilli(now).In(loc).Format("01-02 15:04")
		switch v.Kind {
		case "skip":
			if _, err := env.DB.ExecContext(ctx, `UPDATE schedules SET next_at = ?, skips = skips + 1, last_note = ? WHERE id = ?`,
				v.Next, fmt.Sprintf("%s 上一轮 %s 没结束，跳过%s", day, v.Open, missed), x.ID); err != nil {
				return err
			}
		case "run":
			if _, err := runRound(ctx, env, x, v.Next, day+" 到点生成"+missed, now, loc); err != nil {
				env.Log.Error("周期任务这一轮没派出去", "schedule", x.ID, "err", err)
			}
		}
	}
	return nil
}

// 有周期任务新建时叫醒巡检循环重新算等多久。
var (
	wakeMu sync.Mutex
	wakeCh = make(chan struct{}, 1)
)

func wake() {
	wakeMu.Lock()
	defer wakeMu.Unlock()
	select {
	case wakeCh <- struct{}{}:
	default:
	}
}

// Run 是周期任务的后台循环：睡到最早的下一轮（最多一分钟），醒来巡检一次。
func Run(ctx context.Context, env *app.Env) error {
	for {
		if err := Tick(ctx, env, store.Now(), time.Local); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		wait := time.Minute
		var next sql.NullInt64
		if err := env.DB.QueryRowContext(ctx, `SELECT min(next_at) FROM schedules`).Scan(&next); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if next.Valid {
			wait = min(wait, max(time.Duration(next.Int64-store.Now())*time.Millisecond, time.Second))
		}
		select {
		case <-ctx.Done():
			return nil
		case <-wakeCh:
		case <-time.After(wait):
		}
	}
}
