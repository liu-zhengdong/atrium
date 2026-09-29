package workers

import (
	"context"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 执行者可用性：某个「工具+模型」在某台机器上此刻能不能接活。执行者退出时按信号记不可用（MarkOf），
// 挑执行者与挑机器时跳过（Blocked）；workers 列出，workers --clear 手动解除。

// QuotaHold 是额度用尽但报文没写恢复时刻时的保守缺省。
const QuotaHold = 4 * time.Hour

// Mark 是一条不可用标记。
type Mark struct {
	Tool     string `json:"tool"`
	Model    string `json:"model,omitempty"` // 空表示这台上这个工具的全部模型（起不来）
	Host     string `json:"host"`
	Kind     string `json:"kind"`   // 同 Signal.Kind：quota setup model
	Reason   string `json:"reason"` // 额度用尽、没登录、缺运行环境、模型名无效
	Evidence string `json:"evidence,omitempty"`
	Until    int64  `json:"until"` // 到这个时刻自动恢复；0 等人处理后 workers --clear
	Since    int64  `json:"since"`
}

// Target 是「工具[+模型]@机器」。
func (m Mark) Target() string {
	return Spec{Tool: m.Tool, Model: m.Model}.String() + "@" + m.Host
}

// Covers：这条标记挡住这个执行者（不论机器）——同一工具，标记没写模型或模型相同。
func (m Mark) Covers(s Spec) bool { return m.Tool == s.Tool && (m.Model == "" || m.Model == s.Model) }

// Text 是给人看的一句：原因与什么时候恢复。
func (m Mark) Text() string {
	if m.Until > 0 {
		return m.Reason + "，" + time.UnixMilli(m.Until).Local().Format("01-02 15:04") + " 恢复"
	}
	return m.Reason + "，等人处理后 atrium workers --clear " + m.Target()
}

// MarkOf 把退出信号翻成不可用标记（纯函数）：额度用尽标「工具+模型」到报文里的恢复时刻（读不出按 QuotaHold）；
// 起不来（没登录、缺运行环境）标这台上的整个工具；模型名无效标「工具+模型」，后两种等人处理。其余信号不标。
func MarkOf(sig Signal, s Spec, host string, now time.Time) (Mark, bool) {
	m := Mark{Tool: s.Tool, Model: s.Model, Host: host, Kind: sig.Kind, Evidence: sig.Evidence, Since: now.UnixMilli()}
	switch sig.Kind {
	case SignalQuota:
		m.Reason, m.Until = "额度用尽", sig.ResetAt
		if m.Until == 0 {
			m.Until = now.Add(QuotaHold).UnixMilli()
		}
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

// SetMark 记一条标记（同一「工具+模型@机器」覆盖），顺手删掉已到期的。
func SetMark(ctx context.Context, q store.Querier, m Mark) error {
	if _, err := q.ExecContext(ctx, `DELETE FROM worker_marks WHERE until > 0 AND until <= ?`, m.Since); err != nil {
		return err
	}
	_, err := q.ExecContext(ctx, `INSERT INTO worker_marks (tool, model, host, kind, reason, evidence, until, since)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tool, model, host) DO UPDATE SET kind = excluded.kind,
		reason = excluded.reason, evidence = excluded.evidence, until = excluded.until, since = excluded.since`,
		m.Tool, m.Model, m.Host, m.Kind, m.Reason, m.Evidence, m.Until, m.Since)
	return err
}

// Marks 是此刻有效的标记（按工具、模型、机器排）。
func Marks(ctx context.Context, q store.Querier, now int64) ([]Mark, error) {
	rows, err := q.QueryContext(ctx, `SELECT tool, model, host, kind, reason, evidence, until, since FROM worker_marks
		WHERE until = 0 OR until > ? ORDER BY tool, model, host LIMIT 500`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Mark{}
	for rows.Next() {
		var m Mark
		if err := rows.Scan(&m.Tool, &m.Model, &m.Host, &m.Kind, &m.Reason, &m.Evidence, &m.Until, &m.Since); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ClearMarks 手动解除「工具[+模型][@机器]」：没写模型解除这个工具的全部，没写机器解除全部机器上的。返回解除了几条。
func ClearMarks(ctx context.Context, q store.Querier, target string) (int64, error) {
	who, host, _ := strings.Cut(strings.TrimSpace(target), "@")
	s, err := ParseWorker(who)
	if err != nil {
		return 0, api.Usage("--clear: 写成 工具[+模型][@机器]，如 agy+claude-opus-4-6-thinking@h1（%s）", err.(*api.Error).Message)
	}
	res, err := q.ExecContext(ctx, `DELETE FROM worker_marks WHERE tool = ? AND (? = '' OR model = ?) AND (? = '' OR host = ?)`,
		s.Tool, s.Model, s.Model, host, host)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
