package agenda

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 定时任务 sN：到点在部门下生成一件普通任务并按 task run 派发；上一轮没结束就跳过记一笔；停机错过只补一轮。
// 一次性的（--on）到点生成一次，生成后这条删掉（生成的任务不动）。

// Enqueue 把一件任务送进分派任务队列（即 task run）。由 dispatch 在装配时接上：
//
//	agenda.Enqueue = func(ctx context.Context, env *app.Env, task, actor string) error { … }
//
// 没接上时定时任务照样生成任务，但那一轮记「分派任务未接入」并报错。
var Enqueue func(ctx context.Context, env *app.Env, task, actor string) error

var Kinds = map[string]string{"task": "自定义", "patrol": "体验巡检", "research": "调研"}

// DispatchFailed 是一轮分派任务失败时记在 last_note 里的字样；网页据此把这一轮标红。
const DispatchFailed = "分派任务失败"

const (
	maxScheduleTitle  = 150
	maxScheduleDetail = 8000
	recentChoices     = 5 // 调研轮附最近几份拍过板的选项单
)

// kindNote 是按种类附在生成任务详述末尾的做法。
var kindNote = map[string]string{
	"patrol":   "这是体验巡检：按真实用法把主路径走一遍，记下卡住、看不懂、出错的地方；能修的开 PR，修不了的写进任务备注。",
	"research": "这是调研：调研完在工作目录根写 " + ChoiceFile + "，交付时登记成选项单交用户拍板。" + ChoiceFormat,
}

type Schedule struct {
	ID        string `json:"id"`
	Org       string `json:"org"`
	Kind      string `json:"kind"`
	Every     string `json:"every"`
	EveryMs   int64  `json:"every_ms"` // 0 是一次性的
	Once      bool   `json:"once,omitempty"`
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
	scanErr   error // 后台列表把单条字段扫描错误留在该记录上
}

type NewSchedule struct {
	Org    string `json:"org"`
	Title  string `json:"title"`
	Kind   string `json:"kind"`
	Every  string `json:"every"`
	On     string `json:"on"`
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
	if x.Once = x.EveryMs == 0; !x.Once {
		x.Every = EveryText(x.EveryMs)
	}
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
		return Schedule{}, api.NotFound("定时任务 %s 不存在", id).WithNext("atrium schedule ls")
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

// AddSchedule 建一条定时任务：--every 的第一轮按 FirstDue；--on 的按 ParseOn。
func AddSchedule(ctx context.Context, db *store.DB, in NewSchedule, actor string, now int64, loc *time.Location) (Schedule, error) {
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
	every, at, next, err := scheduleTime(in, now, loc)
	if err != nil {
		return Schedule{}, err
	}
	var id string
	err = db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := org.Get(ctx, tx, in.Org); err != nil {
			return err
		}
		if in.Skill != "" {
			if _, err := org.GetSkill(ctx, tx, in.Skill); err != nil {
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
			strings.TrimSpace(in.Title), in.Detail, in.Skill, next, actor, now)
		return err
	})
	if err != nil {
		return Schedule{}, err
	}
	wake()
	return GetSchedule(ctx, db, id)
}

// scheduleTime 由 --every／--on 与 --at 算出周期、钟点与第一次到点；一次性的周期为 0、不存钟点（时刻就是 next）。
func scheduleTime(in NewSchedule, now int64, loc *time.Location) (every int64, at *int, next int64, err error) {
	switch {
	case in.On != "" && in.Every != "":
		return 0, nil, 0, api.Usage("--on: 和 --every 只能给一个：--on 指定那天触发一次，--every 按周期反复")
	case in.On != "":
		// 体验巡检只派本机靠 LocalOnly 查这条记录，一次性的生成任务后就删了，派发时已查不到。
		if in.Kind == "patrol" {
			return 0, nil, 0, api.Usage("--kind: 一次性的（--on）只支持 task、research；体验巡检用 --every")
		}
		next, err = ParseOn(in.On, in.At, now, loc)
		return 0, nil, next, err
	case in.Every == "":
		return 0, nil, 0, api.Usage("--every: 不能为空（如 7d）；只触发一次用 --on 2026-10-08")
	}
	if every, err = ParseEvery(in.Every); err != nil {
		return 0, nil, 0, err
	}
	if in.At != "" {
		m, err := ParseAt(in.At, every)
		if err != nil {
			return 0, nil, 0, err
		}
		at = &m
	}
	return every, at, FirstDue(now, every, at, loc), nil
}

func RemoveSchedule(ctx context.Context, db *store.DB, id string) (Schedule, error) {
	x, err := GetSchedule(ctx, db, id)
	if err != nil {
		return Schedule{}, err
	}
	_, err = db.ExecContext(ctx, `DELETE FROM schedules WHERE id = ?`, id)
	return x, err
}

// Rounds 是定时任务最近生成的 n 轮任务（created 经历的 actor 是 sN，含手动生成的），新的在前。
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

// ScheduleOf 是 Rounds 的反查：任务是哪条定时任务生成的一轮；不是（或那条已删）为空。
func ScheduleOf(ctx context.Context, q store.Querier, task string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx, `SELECT s.id FROM task_events e JOIN schedules s ON s.id = e.actor
		WHERE e.task = ? AND e.kind = 'created' LIMIT 1`, task).Scan(&id)
	if store.IsNotFound(err) {
		return "", nil
	}
	return id, err
}

// kindLocal 是每轮只能派到服务所在本机的种类与原因。
var kindLocal = map[string]string{"patrol": "体验巡检要打开服务的只读网页，网页只认本机地址"}

// LocalOnly 是任务只能派到本机的原因：它是这些种类的定时任务生成的一轮；不是（或那条已删）为空。
func LocalOnly(ctx context.Context, q store.Querier, task string) (string, error) {
	var kind string
	err := q.QueryRowContext(ctx, `SELECT s.kind FROM task_events e JOIN schedules s ON s.id = e.actor
		WHERE e.task = ? AND e.kind = 'created' LIMIT 1`, task).Scan(&kind)
	if store.IsNotFound(err) {
		return "", nil
	}
	return kindLocal[kind], err
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
	if x.Once {
		parts = append(parts, fmt.Sprintf("（定时任务 %s 定在 %s 的一次）", x.ID, time.UnixMilli(x.NextAt).In(loc).Format("01-02 15:04")))
	} else {
		parts = append(parts, fmt.Sprintf("（定时任务 %s 每 %s 生成的一轮）", x.ID, x.Every))
	}
	return title, strings.Join(parts, "\n\n")
}

// recentUnpicked 是部门最近几份拍过板的选项单里没选的，每份一行。
func recentUnpicked(ctx context.Context, q store.Querier, dept string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT id FROM choices WHERE department = ? AND status IN ('picked', 'passed')
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

// runRound 生成一轮：建任务、送进分派任务队列、记在定时任务上。next 为 0 表示不改下一轮（手动 run）。
// 一次性的只要任务建成就删掉这条（分派任务失败的由任务自己转受阻带出原因），不会再生成第二次。
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
		runErr = fmt.Errorf("分派任务未接入：dispatch 没有设置 agenda.Enqueue，%s 留在 todo", t.ID)
	} else {
		runErr = Enqueue(ctx, env, t.ID, x.ID)
	}
	if runErr != nil {
		note = strings.TrimSpace(note + " " + DispatchFailed + "：" + runErr.Error())
	}
	if x.Once {
		_, err = env.DB.ExecContext(ctx, `DELETE FROM schedules WHERE id = ?`, x.ID)
	} else {
		_, err = env.DB.ExecContext(ctx, `UPDATE schedules SET last_task = ?, last_run_at = ?, next_at = ?, last_note = ? WHERE id = ?`,
			t.ID, now, next, note, x.ID)
	}
	if err != nil {
		return t, err
	}
	return t, runErr
}

// RunNow 是 schedule run：马上生成一轮（不改下一轮的时间；一次性的生成后删掉）；上一轮没结束就拒绝。
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
