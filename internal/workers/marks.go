package workers

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 执行者可用性：某个「工具+模型」在某台机器上此刻能不能接活。执行者退出时按信号记不可用（MarkOf），
// 机器定期自检（hosts 跑 --version）不过的记 MarkProbe、跑通了自动解除（SyncProbes）；
// 挑执行者与挑机器时跳过（Blocked）；workers 列出，workers edit --wait-subscription 转成等订阅恢复，--clear 手动解除。

// MarkProbe 是自检不过的标记种类：只由下一次自检解除，退出信号记的标记不归它管。
const MarkProbe = "probe"

// MarkSubscription 是等订阅恢复的标记种类（如订阅已封号，重登修不好）：只由 workers edit --wait-subscription
// 从已有标记转来，用户明说恢复后才 --clear；照样挡活，但不进「等你」、不出登录指引。退出信号不自动判这一类。
const MarkSubscription = "subscription"

// Hold 是会自己恢复、但不知道何时恢复的标记挡多久：额度用尽而报文没写恢复时刻，或零步骤出错退出（原因不明）。
const Hold = 4 * time.Hour

// Mark 是一条不可用标记。
type Mark struct {
	Tool     string `json:"tool"`
	Model    string `json:"model,omitempty"` // 空表示这台上这个工具的全部模型（起不来）
	Host     string `json:"host"`
	Kind     string `json:"kind"`   // 同 Signal.Kind：quota setup model nostart；另有 probe、subscription
	Reason   string `json:"reason"` // 额度用尽、没登录、缺运行环境、工具版本过旧、模型名无效、零步骤出错退出
	Evidence string `json:"evidence,omitempty"`
	Until    int64  `json:"until"` // 到这个时刻自动恢复；0 等人处理后 workers edit --clear
	Since    int64  `json:"since"`
	// OpenEnded：报文没写恢复时刻（如 grok 402 balance exhausted），Until 只是到期自动再试的上限，不是恢复时刻，不展示成「恢复」。
	OpenEnded bool `json:"open_ended,omitempty"`
}

// Target 是「工具[+模型]@机器」。
func (m Mark) Target() string {
	return Spec{Tool: m.Tool, Model: m.Model}.String() + "@" + m.Host
}

// Covers：这条标记挡住这个执行者（不论机器）——同一工具，标记没写模型或模型相同。
func (m Mark) Covers(s Spec) bool { return m.Tool == s.Tool && (m.Model == "" || m.Model == s.Model) }

// Text 是给人看的一句：原因与什么时候恢复（等人处理的写怎么处理）。
func (m Mark) Text() string {
	if m.Until > 0 {
		when := time.UnixMilli(m.Until).Local().Format("01-02 15:04")
		if m.OpenEnded {
			return m.Reason + "，报文没写恢复时刻；" + when + " 起自动再试"
		}
		return m.Reason + "，" + when + " 恢复"
	}
	return m.Reason + "，" + m.Fix()
}

// Fix 是等人处理（until=0）的标记怎么处理：「等你」的副行与投秘书的事件都用它。
func (m Mark) Fix() string {
	switch m.Kind {
	case MarkProbe:
		return "修好后自检跑通自动解除，或 atrium workers edit --clear " + m.Target()
	case SignalModel:
		return "改对模型名后 atrium workers edit --clear " + m.Target()
	case MarkSubscription:
		return "等订阅恢复，用户明说后 atrium workers edit --clear " + m.Target()
	}
	return "登录、装好或升级运行环境后 atrium workers edit --clear " + m.Target()
}

// MarkOf 把退出信号翻成不可用标记（纯函数）：额度用尽标「工具+模型」到报文里的恢复时刻（报文没写的标「恢复时间未知」，
// Hold 后到点自动再试，不拿 Hold 冒充恢复时刻）；
// 零步骤出错退出标「工具+模型」Hold 这么久（同工具别的模型可能是好的；原因不明，可能是临时故障，到期再试）；
// 起不来（没登录、缺运行环境、工具版本过旧）标这台上的整个工具；模型名无效标「工具+模型」，后两种等人处理。其余信号不标。
func MarkOf(sig Signal, s Spec, host string, now time.Time) (Mark, bool) {
	m := Mark{Tool: s.Tool, Model: s.Model, Host: host, Kind: sig.Kind, Evidence: sig.Evidence, Since: now.UnixMilli()}
	switch sig.Kind {
	case SignalQuota:
		m.Reason, m.Until = "额度用尽", sig.ResetAt
		if m.Until == 0 {
			m.Until, m.OpenEnded = now.Add(Hold).UnixMilli(), true
		}
	case SignalNoStart:
		m.Reason, m.Until = sig.Reason, now.Add(Hold).UnixMilli()
	case SignalSetup:
		m.Reason, m.Model = sig.Reason, ""
	case SignalModel:
		m.Reason = "模型名无效"
	default:
		return Mark{}, false
	}
	return m, true
}

// Blocked 找挡住「工具+模型@机器」的标记（纯函数，marks 已去掉到期的）：同一台、且 Covers。
func Blocked(marks []Mark, tool, model, host string) (Mark, bool) {
	for _, m := range marks {
		if m.Host == host && m.Covers(Spec{Tool: tool, Model: model}) {
			return m, true
		}
	}
	return Mark{}, false
}

// SetMark 记一条标记（同一「工具+模型@机器」覆盖），顺手删掉已到期的；新出现等人处理的，同一事务里投秘书（见 settle）。
func SetMark(ctx context.Context, db *store.DB, m Mark) error {
	return db.Tx(ctx, func(tx *sql.Tx) error { return setMark(ctx, tx, m) })
}

// setMark 是标记的唯一写入：退出信号（SetMark）与机器自检（SyncProbes）都经这里。
func setMark(ctx context.Context, q store.Querier, m Mark) error {
	if _, err := q.ExecContext(ctx, `DELETE FROM worker_marks WHERE until > 0 AND until <= ?`, m.Since); err != nil {
		return err
	}
	var prev *Mark
	var p Mark
	err := q.QueryRowContext(ctx, `SELECT tool, model, host, kind, reason, evidence, until, since, open_ended FROM worker_marks
		WHERE tool = ? AND model = ? AND host = ?`, m.Tool, m.Model, m.Host).
		Scan(&p.Tool, &p.Model, &p.Host, &p.Kind, &p.Reason, &p.Evidence, &p.Until, &p.Since, &p.OpenEnded)
	switch {
	case err == nil:
		prev = &p
	case !store.IsNotFound(err):
		return err
	}
	m, write, fresh := settle(prev, m)
	if !write {
		return nil
	}
	if _, err := q.ExecContext(ctx, `INSERT INTO worker_marks (tool, model, host, kind, reason, evidence, until, since, open_ended)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tool, model, host) DO UPDATE SET kind = excluded.kind,
		reason = excluded.reason, evidence = excluded.evidence, until = excluded.until, since = excluded.since,
		open_ended = excluded.open_ended`,
		m.Tool, m.Model, m.Host, m.Kind, m.Reason, m.Evidence, m.Until, m.Since, m.OpenEnded); err != nil {
		return err
	}
	if !fresh {
		return nil
	}
	return events.Emit(ctx, q, events.Event{Kind: events.WorkerDown, Target: events.Secretary, Level: events.Act,
		Key: "worker:" + m.Target(), Body: map[string]any{"target": m.Target(), "reason": m.Reason, "next": m.Fix()}})
}

// settle 判定写一条标记（纯函数）。prev 是同一「工具+模型@机器」此刻有效的标记，没有为 nil。
//   - write：自检标记不覆盖别的种类（没登录、额度用尽……已经挡着，也不该随自检跑通一起解除）。
//   - fresh：新出现一条等人处理（until=0）的标记，要推给秘书；同一目标已有同一种等人处理的只是刷新，不算新，
//     并沿用原来的 since（「等你」按它算等了多久）。额度用尽这类会自己恢复的不推。
func settle(prev *Mark, m Mark) (out Mark, write, fresh bool) {
	if m.Kind == MarkProbe && prev != nil && prev.Kind != MarkProbe {
		return m, false, false
	}
	if m.Until != 0 {
		return m, true, false
	}
	if prev != nil && prev.Until == 0 && prev.Kind == m.Kind {
		m.Since = prev.Since
		return m, true, false
	}
	return m, true, true
}

// SyncProbes 按一台机器这一轮的自检结果改标记：failed 里的工具记（或刷新）MarkProbe，这台上其余工具的 MarkProbe 解除。
func SyncProbes(ctx context.Context, db *store.DB, host string, failed []Mark, now int64) error {
	return db.Tx(ctx, func(tx *sql.Tx) error {
		tools := []string{}
		for _, m := range failed {
			tools = append(tools, m.Tool)
			m.Model, m.Host, m.Kind, m.Until, m.Since = "", host, MarkProbe, 0, now
			if err := setMark(ctx, tx, m); err != nil {
				return err
			}
		}
		raw, _ := json.Marshal(tools)
		_, err := tx.ExecContext(ctx, `DELETE FROM worker_marks WHERE host = ? AND kind = ? AND tool NOT IN (SELECT value FROM json_each(?))`,
			host, MarkProbe, string(raw))
		return err
	})
}

// Marks 是此刻有效的标记（按工具、模型、机器排）。
func Marks(ctx context.Context, q store.Querier, now int64) ([]Mark, error) {
	rows, err := q.QueryContext(ctx, `SELECT tool, model, host, kind, reason, evidence, until, since, open_ended FROM worker_marks
		WHERE until = 0 OR until > ? ORDER BY tool, model, host LIMIT 500`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Mark{}
	for rows.Next() {
		var m Mark
		if err := rows.Scan(&m.Tool, &m.Model, &m.Host, &m.Kind, &m.Reason, &m.Evidence, &m.Until, &m.Since, &m.OpenEnded); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ClearMarks 手动解除「工具[+模型][@机器]」：没写模型解除这个工具的全部，没写机器解除全部机器上的。返回解除了几条。
func ClearMarks(ctx context.Context, q store.Querier, target string) (int64, error) {
	s, host, err := parseMarkTarget("clear", target)
	if err != nil {
		return 0, err
	}
	res, err := q.ExecContext(ctx, `DELETE FROM worker_marks WHERE tool = ? AND (? = '' OR model = ?) AND (? = '' OR host = ?)`,
		s.Tool, s.Model, s.Model, host, host)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// WaitSubscription 把「工具[+模型][@机器]」此刻有效的标记转成等订阅恢复（until=0，since 与证据保留），匹配规则同 ClearMarks。
// 不经 setMark：人已在处理，不再发 worker.down。返回转了几条。
func WaitSubscription(ctx context.Context, q store.Querier, target string, now int64) (int64, error) {
	s, host, err := parseMarkTarget("wait-subscription", target)
	if err != nil {
		return 0, err
	}
	res, err := q.ExecContext(ctx, `UPDATE worker_marks SET kind = ?, reason = '订阅已封号', until = 0
		WHERE tool = ? AND (? = '' OR model = ?) AND (? = '' OR host = ?) AND (until = 0 OR until > ?)`,
		MarkSubscription, s.Tool, s.Model, s.Model, host, host, now)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func parseMarkTarget(flag, target string) (Spec, string, error) {
	who, host, _ := strings.Cut(strings.TrimSpace(target), "@")
	s, err := ParseWorker(who)
	if err != nil {
		return Spec{}, "", api.Usage("--%s: 写成 工具[+模型][@机器]，如 agy+claude-opus-4-6-thinking@h1（%s）", flag, err.(*api.Error).Message)
	}
	return s, host, nil
}
