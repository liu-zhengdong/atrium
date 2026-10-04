package ledger

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Acceptance 是长期任务决定；重派只改变运行状态，不撤销决定。
// Epoch 对应一次交付，Head 对应被验收的 PR；每任务至多一份。
type Acceptance struct {
	Actor  string `json:"actor"`
	Org    string `json:"org,omitempty"`
	Reason string `json:"reason"`
	Epoch  int64  `json:"epoch,omitempty"`
	Head   string `json:"head,omitempty"`
}

func AcceptanceOf(ctx context.Context, q store.Querier, id string) (*Acceptance, error) {
	var a Acceptance
	err := q.QueryRowContext(ctx, `SELECT actor, department, reason, epoch, head FROM task_acceptance WHERE task = ?`, id).Scan(&a.Actor, &a.Org, &a.Reason, &a.Epoch, &a.Head)
	if store.IsNotFound(err) {
		return nil, nil
	}
	return &a, err
}

// DeliveryEpoch 的范围只包含能改变交付的经历，不包含关卡的推进记录。
func DeliveryEpoch(ctx context.Context, q store.Querier, id string) (int64, error) {
	var n int64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(max(id),0) FROM task_events WHERE task = ? AND kind IN ('created','edited','enqueue','requeue','start','launch','result','bounce','facts')`, id).Scan(&n)
	return n, err
}

func MayDecide(ctx context.Context, q store.Querier, a *Acceptance, actor string) error {
	if actor == "u1" || actor == "secretary" || actor == a.Actor {
		return nil
	}
	ps, err := org.Parents(ctx, q)
	if err != nil {
		return err
	}
	lm, err := org.LeaderMap(ctx, q)
	if err != nil {
		return err
	}
	for cur, n := ps[a.Org], 0; cur != "" && n <= org.MaxDepth; cur, n = ps[cur], n+1 {
		if lm[cur] == actor {
			return nil
		}
	}
	return api.Forbidden("任务决定由 %s 作出，只有原决策人或其上级能解除或验收", a.Actor)
}

// Decide 复用 task set 的 accept 字段：hold 设置暂缓，resume 明确解除。
func Decide(ctx context.Context, db *store.DB, id, action, reason, actor string) (Task, error) {
	ctx, unlock := applicationLock(ctx, db)
	defer unlock()
	if action != "hold" && action != "resume" {
		return Task{}, api.Usage("--accept: 应为 hold 或 resume")
	}
	if err := checkText("note", reason, maxNote, true); err != nil {
		return Task{}, err
	}
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		t, err := Get(ctx, tx, id)
		if err != nil {
			return err
		}
		a, err := AcceptanceOf(ctx, tx, id)
		if err != nil {
			return err
		}
		if a != nil {
			if err := MayDecide(ctx, tx, a, actor); err != nil {
				return err
			}
		}
		if action == "resume" {
			if a == nil {
				return api.Conflict("%s 没有任务级验收决定", id)
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM task_acceptance WHERE task = ?`, id); err != nil {
				return err
			}
		} else {
			if t.Status.Finished() {
				return api.Conflict("%s 已结束，不能暂缓", id)
			}
			decisionOrg := ""
			if actor != "u1" && actor != "secretary" {
				ps, err := org.Parents(ctx, tx)
				if err != nil {
					return err
				}
				lm, err := org.LeaderMap(ctx, tx)
				if err != nil {
					return err
				}
				for cur, n := t.Org, 0; cur != "" && n <= org.MaxDepth; cur, n = ps[cur], n+1 {
					if lm[cur] == actor {
						decisionOrg = cur
						break
					}
				}
				if decisionOrg == "" {
					return api.Forbidden("%s 不是任务的负责人或其上级", actor)
				}
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO task_acceptance(task,actor,department,reason,epoch,head) VALUES(?,?,?,?,0,'') ON CONFLICT(task) DO UPDATE SET actor=excluded.actor,department=excluded.department,reason=excluded.reason,epoch=0,head=''`, id, actor, decisionOrg, reason); err != nil {
				return err
			}
		}
		raw, _ := json.Marshal(map[string]string{"action": action, "reason": reason})
		return Record(ctx, tx, id, "acceptance", actor, string(raw))
	})
	if err != nil {
		return Task{}, err
	}
	changed.broadcast()
	return Get(ctx, db, id)
}

// CheckApplication 在实际应用前重读决定与交付；head 为空用于无 PR 的交付。
func CheckApplication(ctx context.Context, q store.Querier, id, head string) error {
	a, err := AcceptanceOf(ctx, q, id)
	if err != nil || a == nil {
		return err
	}
	epoch, err := DeliveryEpoch(ctx, q, id)
	if err != nil {
		return err
	}
	if a.Epoch != epoch || a.Epoch == 0 || a.Head != head {
		return api.Conflict("%s 暂缓应用：%s（决策人 %s）；本次交付需要重新验收", id, a.Reason, a.Actor)
	}
	return nil
}

// acceptanceEvent 是 Apply 的公共入口，覆盖直接完成和绕过关卡的调用。
func acceptanceEvent(ctx context.Context, tx *sql.Tx, t Task, ev *Event, actor string) error {
	a, err := AcceptanceOf(ctx, tx, t.ID)
	if err != nil || a == nil {
		return err
	}
	switch ev.Kind {
	case Accept:
		if err := MayDecide(ctx, tx, a, actor); err != nil {
			return err
		}
		who, _, err := org.Acceptor(ctx, tx, t.Org)
		if err != nil {
			return err
		}
		if !org.MayAccept(actor, who) {
			return api.Forbidden("部门要求用户验收，%s 不能代验", actor)
		}
		epoch, err := DeliveryEpoch(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		if ev.Epoch != epoch {
			return api.Conflict("交付已变化，请重新验收")
		}
		_, err = tx.ExecContext(ctx, `UPDATE task_acceptance SET epoch=?,head=? WHERE task=?`, epoch, ev.Head, t.ID)
		return err
	case GatePass, ReviewPass, Deliver:
		who, _, err := org.Acceptor(ctx, tx, t.Org)
		if err != nil {
			return err
		}
		ev.AcceptBy = org.AcceptLeader
		if who == org.AcceptUser {
			ev.AcceptBy = org.AcceptUser
		}
	case Set:
		if ev.To == Done {
			return api.Conflict("%s 有任务级验收决定，完成须经 task accept", t.ID)
		}
	case Land:
		epoch, err := DeliveryEpoch(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		if a.Epoch != epoch || a.Epoch == 0 {
			return fmt.Errorf("%s 的本次交付未验收", t.ID)
		}
	}
	return nil
}
