package leaders

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Escalation 是上报的回执。
type Escalation struct {
	To   string `json:"to"`
	Kind string `json:"kind"`
	Task string `json:"task,omitempty"`
}

// Escalate：负责人上报一件事，发给上一层负责人（没有投秘书），notify 直接投秘书；给了任务就在任务经历里也记一笔。
// 转交下层上报（--event）时带上原文；原事件由这位自己 events ack。
func Escalate(ctx context.Context, db *store.DB, leader string, in EscalateIn) (Escalation, error) {
	if err := CheckEscalate(in); err != nil {
		return Escalation{}, err
	}
	var out Escalation
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		ps, err := org.Parents(ctx, tx)
		if err != nil {
			return err
		}
		lm, err := org.LeaderMap(ctx, tx)
		if err != nil {
			return err
		}
		body := map[string]any{"from": leader, "kind": in.Kind, "label": kindLabel(in.Kind), "note": in.Note}
		task, dept := in.Task, ""
		if in.Event != 0 {
			var target, kind, raw string
			var evTask, evDept sql.NullString
			err := tx.QueryRowContext(ctx, `SELECT target, kind, task, department, body FROM events WHERE id = ?`, in.Event).
				Scan(&target, &kind, &evTask, &evDept, &raw)
			if store.IsNotFound(err) {
				return api.NotFound("--event: 事件 #%d 不存在", in.Event)
			}
			if err != nil {
				return err
			}
			if target != leader {
				return Forbid("--event: 事件 #%d 发给 %s，不是你（%s）", in.Event, target, leader)
			}
			body["event"] = in.Event
			body["original"] = map[string]any{"kind": kind, "body": json.RawMessage(orNull(raw))}
			if task == "" {
				task = evTask.String
			}
			dept = evDept.String
		}
		if task != "" {
			t, err := ledger.Get(ctx, tx, task)
			if err != nil {
				return err
			}
			if err := InScope(leader, org.Scope(ps, lm, leader), []Check{{What: "任务 " + t.ID, Dept: t.Org}}); err != nil {
				return err
			}
			dept = t.Org
		}
		to := org.Secretary
		if in.Kind != "notify" {
			to = Upstream(ps, lm, leader, dept)
		}
		out = Escalation{To: to, Kind: in.Kind, Task: task}
		if err := events.Emit(ctx, tx, events.Event{Kind: events.LeaderEscalate, Task: task, Dept: dept,
			Target: out.To, Body: body}); err != nil {
			return err
		}
		if task != "" {
			return ledger.Record(ctx, tx, task, "escalated", leader,
				fmt.Sprintf("上报 %s（%s）：%s", out.To, kindLabel(in.Kind), in.Note))
		}
		return nil
	})
	return out, err
}

// orNull：事件体可能是 JSON 或空串；空串当 null，非 JSON 当字符串。
func orNull(raw string) string {
	if raw == "" {
		return "null"
	}
	if json.Valid([]byte(raw)) {
		return raw
	}
	b, _ := json.Marshal(raw)
	return string(b)
}
