package agenda

import (
	"context"
	"database/sql"
	"net/url"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Void 结束仍待拍板的选项单，不建任务、不记成用户未选。
func Void(ctx context.Context, db *store.DB, id, reason, actor string) (Choice, error) {
	choiceMu.Lock()
	defer choiceMu.Unlock()
	reason = strings.TrimSpace(reason)
	if err := need("--reason", reason, maxPickNote); err != nil {
		return Choice{}, err
	}
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		c, err := GetChoice(ctx, tx, id)
		if err != nil {
			return err
		}
		if c.Status != "open" {
			return api.Conflict("%s 已结束（%s）", id, c.Status)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE choices SET status = 'void', note = ?, decided_at = ? WHERE id = ? AND status = 'open'`, reason, store.Now(), id); err != nil {
			return err
		}
		// 原有待拍板通知也结束，秘书不再收到已经作废的请求。
		_, err = tx.ExecContext(ctx, `UPDATE events SET acked_at = ?, acked_by = ? WHERE kind = ? AND json_extract(body, '$.choice') = ? AND acked_at IS NULL`, store.Now(), actor, events.ChoiceOpen, id)
		return err
	})
	if err != nil {
		return Choice{}, err
	}
	return GetChoice(ctx, db, id)
}

func voidRoute(env *app.Env) api.Handler {
	return func(q *api.Req) (any, error) {
		// 秘书使用用户令牌，但署名是 secretary；用户本人不能作废。
		if q.Actor.Kind != "leader" && !(q.Actor.Kind == "user" && q.Actor.ID == org.Secretary) {
			return nil, api.Forbidden("只有负责人或秘书能作废选项单")
		}
		id, err := q.Ref("id", "c")
		if err != nil {
			return nil, err
		}
		var in struct {
			Reason string `json:"reason"`
		}
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return Void(q.Context(), env.DB, id, in.Reason, q.Actor.ID)
	}
}

func choiceVoid(c *cli.Ctx) error {
	id, err := c.Arg(0, "<cN>")
	if err != nil {
		return err
	}
	if err := c.MaxArgs(1); err != nil {
		return err
	}
	var ch Choice
	if err := c.Call("POST", "/api/choices/"+url.PathEscape(id)+"/void", map[string]string{"reason": c.Str("reason")}, &ch); err != nil {
		return err
	}
	return c.Done(ch, ch.ID+" 已作废："+ch.Note, "atrium choice ls")
}
