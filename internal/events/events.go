// Package events：待投递事件先落库，再由订阅者 events wait 取走（起 15 分钟租约）、events ack 确认。
//
// 分两级：act（要处理）与 info（知会）；wait 缺省只取要处理的，--all 连知会一起取。
// 投递对象（target）留空时调 org.Recipient：部门往上最近的负责人，没有投 secretary。
// 任务事件经 EmitTask 按处理人分发（Route）：结果投处理人（缺省派活的人），负责人另收知会。
// 同一投递对象同一去重键、还没取走也没确认的事件合并成一条（count 加一），免得刷屏。
// 一次操作引出的事件不投给做这次操作的身份本人（Event.By 与投递对象相同就不投）。
// 判定（级别、去重键、投递对象）是纯函数，在 model.go；本文件是落库与等待。
package events

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 事件种类。新增种类在这里加常量，别处不写字符串字面量。
const (
	TaskStatus   = "task.status"   // 任务状态变化（含转入已合入）；Body: {"from","to","stage","title","note"?}
	Overdue      = "overdue"       // 持球人到期（watch 包发）；Body: {"holder","held_ms","next",…}
	ChoiceOpen   = "choice.open"   // 有选项单等用户拍板（org/agenda 发，投秘书）；Body: {"choice","title"}
	OnlineFailed = "online.failed" // 自升级失败（release 发，投秘书；同一版本本进程只发一次）；Body: {"from","to","error"}
	LimitFull    = "limit.full"    // 刚到或超了上限（watch 巡检发）；Body: {"key","what","used","max","unit","fix","next","text"}
)

// 级别。
const (
	Act  = "act"  // 要处理
	Info = "info" // 知会
)

// Secretary 是没有负责人时的投递对象。
const Secretary = org.Secretary

// Lease 是取走后的租约：租约内不重投，到期没确认再投。
const Lease = 15 * time.Minute

// Event 是一条待投递事件。Target 留空由本包按部门解析；Level、Key 留空按种类取缺省（model.go）。
// By 是引起它的身份（u1、secretary、aN 或运行时）：投递对象就是它时不投，自己做的事不用再告诉自己。
type Event struct {
	Kind   string
	Task   string
	Dept   string
	Target string
	Level  string
	Key    string
	Body   any
	By     string
}

// Row 是库里的一条事件。
type Row struct {
	ID          int64           `json:"id"`
	At          int64           `json:"at"`
	UpdatedAt   int64           `json:"updated_at"`
	Kind        string          `json:"kind"`
	Level       string          `json:"level"`
	Count       int             `json:"count"`
	Task        string          `json:"task,omitempty"`
	Dept        string          `json:"org,omitempty"`
	Target      string          `json:"target"`
	Body        json.RawMessage `json:"body,omitempty"`
	LeasedUntil *int64          `json:"leased_until,omitempty"`
	AckedAt     *int64          `json:"acked_at,omitempty"`
}

// Emit 在调用方的事务里落一条事件：与引起它的状态变化同生同死。
// 同一投递对象同一去重键还有没取走、没确认的，就合并进那一条（正文换成最新的、count 加一、级别取高）。
func Emit(ctx context.Context, q store.Querier, e Event) error {
	body := ""
	if e.Body != nil {
		raw, err := json.Marshal(e.Body)
		if err != nil {
			return err
		}
		body = string(raw)
	}
	if e.Level == "" {
		e.Level = LevelOf(e.Kind, e.Body)
	}
	if e.Key == "" {
		e.Key = KeyOf(e)
	}
	if e.Target == "" {
		t, err := org.Recipient(ctx, q, e.Dept)
		if err != nil {
			return err
		}
		e.Target = t
	}
	if e.Target == e.By {
		return nil
	}
	now := store.Now()
	if e.Key != "" {
		res, err := q.ExecContext(ctx, `UPDATE events SET body = ?, updated_at = ?, count = count + 1,
			level = CASE WHEN level = 'act' OR ? = 'act' THEN 'act' ELSE 'info' END
			WHERE id = (SELECT id FROM events WHERE key = ? AND target = ? AND acked_at IS NULL
			AND (leased_until IS NULL OR leased_until < ?) ORDER BY id DESC LIMIT 1)`,
			body, now, e.Level, e.Key, e.Target, now)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			notifySoon()
			return nil
		}
	}
	_, err := q.ExecContext(ctx,
		`INSERT INTO events (at, updated_at, kind, level, key, task, department, target, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		now, now, e.Kind, e.Level, e.Key, store.Null(e.Task), store.Null(e.Dept), e.Target, body)
	if err == nil {
		notifySoon()
	}
	return err
}

// EmitTask 在调用方的事务里发一件任务的事件：按处理人 owner 与部门负责人分发（见 Route）。
func EmitTask(ctx context.Context, q store.Querier, owner string, e Event) error {
	leader, err := org.Recipient(ctx, q, e.Dept)
	if err != nil {
		return err
	}
	if leader == Secretary {
		leader = ""
	}
	for _, d := range Route(owner, leader, e.Kind, e.Body) {
		e.Target, e.Level = d.Target, d.Level
		if err := Emit(ctx, q, e); err != nil {
			return err
		}
	}
	return nil
}

// Seen 判断某投递对象是否收到过（含已确认的）这个去重键的事件：watch 用它保证同一次到期只发一回。
func Seen(ctx context.Context, q store.Querier, target, key string) (bool, error) {
	var one int
	err := q.QueryRowContext(ctx, `SELECT 1 FROM events WHERE key = ? AND target = ? LIMIT 1`, key, target).Scan(&one)
	if store.IsNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

const rowCols = `id, at, updated_at, kind, level, count, task, department, target, body, leased_until, acked_at`

func scanRows(rows *sql.Rows) ([]Row, error) {
	defer rows.Close()
	out := []Row{}
	for rows.Next() {
		var r Row
		var task, dept sql.NullString
		var body string
		var leased, acked sql.NullInt64
		if err := rows.Scan(&r.ID, &r.At, &r.UpdatedAt, &r.Kind, &r.Level, &r.Count, &task, &dept, &r.Target,
			&body, &leased, &acked); err != nil {
			return nil, err
		}
		r.Task, r.Dept = task.String, dept.String
		if body != "" {
			r.Body = json.RawMessage(body)
		}
		if leased.Valid {
			r.LeasedUntil = &leased.Int64
		}
		if acked.Valid {
			r.AckedAt = &acked.Int64
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// maxBatch 是一次取走的上限。
const maxBatch = 50

func levelClause(all bool) string {
	if all {
		return ""
	}
	return ` AND level = 'act'`
}

// available 数一下能取的（没确认、不在租约内）。
func available(ctx context.Context, q store.Querier, target string, all bool, now int64) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT count(*) FROM events WHERE target = ? AND acked_at IS NULL
		AND (leased_until IS NULL OR leased_until < ?)`+levelClause(all), target, now).Scan(&n)
	return n, err
}

// Take 取走一批能取的事件并起租约。
func Take(ctx context.Context, db *store.DB, target string, all bool) ([]Row, error) {
	var out []Row
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		now := store.Now()
		rows, err := tx.QueryContext(ctx, `SELECT `+rowCols+` FROM events WHERE target = ? AND acked_at IS NULL
			AND (leased_until IS NULL OR leased_until < ?)`+levelClause(all)+` ORDER BY id LIMIT ?`, target, now, maxBatch)
		if err != nil {
			return err
		}
		if out, err = scanRows(rows); err != nil {
			return err
		}
		until := now + Lease.Milliseconds()
		for i := range out {
			if _, err := tx.ExecContext(ctx, `UPDATE events SET leased_until = ? WHERE id = ?`, until, out[i].ID); err != nil {
				return err
			}
			out[i].LeasedUntil = &until
		}
		return nil
	})
	return out, err
}

// WaitOpts 是 events wait 的参数。Batch 是首条到了之后再攒多久。
type WaitOpts struct {
	Target  string
	All     bool
	Timeout time.Duration
	Batch   time.Duration
}

// Wait 长轮询：有能取的就（攒 Batch 后）取走返回；到超时返回空。
func Wait(ctx context.Context, db *store.DB, o WaitOpts) ([]Row, error) {
	deadline := time.Now().Add(o.Timeout)
	tick := time.NewTicker(time.Second) // Emit 在事务里，提交前的通知可能扑空：每秒再看一眼
	defer tick.Stop()
	for {
		wake := changed.wait()
		n, err := available(ctx, db, o.Target, o.All, store.Now())
		if err != nil {
			return nil, err
		}
		if n > 0 {
			if left := time.Until(deadline); o.Batch > 0 && left > 0 {
				select {
				case <-time.After(min(o.Batch, left)):
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			return Take(ctx, db, o.Target, o.All)
		}
		left := time.Until(deadline)
		if left <= 0 {
			return []Row{}, nil
		}
		timer := time.NewTimer(left)
		select {
		case <-wake:
		case <-tick.C:
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		}
		timer.Stop()
	}
}

// AckResult 是 events ack 的结果。
type AckResult struct {
	Acked   []int64 `json:"acked"`
	Already []int64 `json:"already,omitempty"`
	Missing []int64 `json:"missing,omitempty"`
}

// Ack 确认事件。onlyTarget 非空时只能确认投给它的（负责人只确认自己的）。
func Ack(ctx context.Context, db *store.DB, ids []int64, onlyTarget, actor string) (AckResult, error) {
	res := AckResult{Acked: []int64{}}
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		now := store.Now()
		for _, id := range ids {
			var target string
			var acked sql.NullInt64
			err := tx.QueryRowContext(ctx, `SELECT target, acked_at FROM events WHERE id = ?`, id).Scan(&target, &acked)
			if store.IsNotFound(err) || (err == nil && onlyTarget != "" && target != onlyTarget) {
				res.Missing = append(res.Missing, id)
				continue
			}
			if err != nil {
				return err
			}
			if acked.Valid {
				res.Already = append(res.Already, id)
				continue
			}
			if _, err := tx.ExecContext(ctx, `UPDATE events SET acked_at = ?, acked_by = ? WHERE id = ?`, now, actor, id); err != nil {
				return err
			}
			res.Acked = append(res.Acked, id)
		}
		return nil
	})
	return res, err
}

// Pending 是某投递对象还没确认的事件（含租约中的），按先后，至多 limit 条。
func Pending(ctx context.Context, q store.Querier, target string, all bool, limit int) ([]Row, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+rowCols+` FROM events WHERE target = ? AND acked_at IS NULL`+
		levelClause(all)+` ORDER BY id LIMIT ?`, target, limit)
	if err != nil {
		return nil, err
	}
	return scanRows(rows)
}

// Backlog 是每个投递对象没确认的要处理事件：条数与最早一条没被取走的时刻（0 表示都已取走）。
type Backlog struct {
	Target     string `json:"target"`
	Count      int    `json:"count"`
	OldestFree int64  `json:"oldest_free,omitempty"`
	Oldest     int64  `json:"oldest"`
}

// Backlogs 汇总全部投递对象的积压（watch 判负责人期限、statusline 判秘书没人听都用它）。
func Backlogs(ctx context.Context, q store.Querier) ([]Backlog, error) {
	now := store.Now()
	rows, err := q.QueryContext(ctx, `SELECT target, count(*), min(at),
		COALESCE(min(CASE WHEN leased_until IS NULL OR leased_until < ? THEN at END), 0)
		FROM events WHERE acked_at IS NULL AND level = 'act' AND kind != ? GROUP BY target ORDER BY target LIMIT 500`, now, Overdue)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Backlog{}
	for rows.Next() {
		var b Backlog
		if err := rows.Scan(&b.Target, &b.Count, &b.Oldest, &b.OldestFree); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// ---- 本进程内的「有新事件」通知 ----

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
	close(n.ch)
	n.ch = make(chan struct{})
	n.mu.Unlock()
}

var changed = &notifier{ch: make(chan struct{})}

// notifySoon：Emit 在调用方事务里，稍等再广播，等待者醒来时多半已能读到提交。
func notifySoon() { time.AfterFunc(30*time.Millisecond, changed.broadcast) }

// ---- 订阅者「在听」（内存，服务重启后由 bridge 下一次心跳补上）----

// Listener 是一个报过「在听」的订阅者。
type Listener struct {
	As    string `json:"as"`
	Via   string `json:"via"`
	Since int64  `json:"since"`
	Until int64  `json:"until"`
}

var listeners = struct {
	sync.Mutex
	m map[string]Listener
}{m: map[string]Listener{}}

// Listen 记下（或续上）某订阅者在听；ttl 内没再报就算不在听。stop 表示不听了。
func Listen(as, via string, ttl time.Duration, stop bool) {
	listeners.Lock()
	defer listeners.Unlock()
	if stop {
		delete(listeners.m, as)
		return
	}
	now := store.Now()
	l, ok := listeners.m[as]
	if !ok || l.Until < now {
		l = Listener{As: as, Since: now}
	}
	l.Via, l.Until = strings.TrimSpace(via), now+ttl.Milliseconds()
	listeners.m[as] = l
}

// Listening 返回某订阅者当前的「在听」记录；不在听为 nil。
func Listening(as string) *Listener {
	listeners.Lock()
	defer listeners.Unlock()
	l, ok := listeners.m[as]
	if !ok || l.Until < store.Now() {
		return nil
	}
	return &l
}
