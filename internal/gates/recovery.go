package gates

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
)

// RestoreMerged 仅供现有 task merge 的显式授权恢复：负责人声明实际产物已核对、受阻仅为关卡错配。
// 自动关卡仍拒绝受阻；恢复后复用 GatePass 的审阅和负责人验收，原 result 不改。
func (g *Gate) RestoreMerged(ctx context.Context, id, actor string, recovery MergedRecovery) (ledger.Task, error) {
	var out ledger.Task
	err := ledger.Application(ctx, g.DB, func(ctx context.Context) error {
		t, err := ledger.Get(ctx, g.DB, id)
		if err != nil {
			return err
		}
		if t.Status != ledger.Blocked || t.Stage != ledger.StageGate {
			return api.Conflict("只恢复 blocked/gate 的已合入复核")
		}
		if strings.TrimSpace(recovery.Reason) == "" || strings.TrimSpace(recovery.Evidence) == "" || len(recovery.Reason) > 2000 || len(recovery.Evidence) > 4000 {
			return api.Usage("--reason/--evidence: 必须记录仅关卡错配的原因与实际交付证据（最多2000/4000字节）")
		}
		ps, err := org.Parents(ctx, g.DB)
		if err != nil {
			return err
		}
		lm, err := org.LeaderMap(ctx, g.DB)
		if err != nil {
			return err
		}
		if actor != "u1" && actor != "secretary" && !org.Scope(ps, lm, actor)[t.Org] {
			return api.Forbidden("只有本任务负责人或其上级能恢复")
		}

		if err := g.validateMergedRecovery(ctx, t); err != nil {
			return err
		}
		c, err := g.checkPRWithRecovery(ctx, t, &recovery)
		if err != nil {
			return err
		}
		if c.block != "" || len(c.reasons) > 0 {
			return api.Conflict("恢复拒绝：%s %s", c.block, strings.Join(c.reasons, "；"))
		}
		if c.review != "" {
			_, err = ledger.Apply(ctx, g.DB, id, ledger.Event{Kind: ledger.GatePass, NeedReview: true}, actor, "显式恢复待审阅："+recovery.Reason+"；"+recovery.Evidence)
		} else {
			by, _, e := org.Acceptor(ctx, g.DB, t.Org)
			if e != nil {
				return e
			}
			if by != org.AcceptUser {
				by = org.AcceptLeader
			}
			_, err = ledger.Apply(ctx, g.DB, id, ledger.Event{Kind: ledger.GatePass, AcceptBy: by}, actor, "显式恢复待验收："+recovery.Reason+"；"+recovery.Evidence)
		}
		if err != nil {
			return err
		}
		out, err = ledger.Get(ctx, g.DB, id)
		return err
	})
	return out, err
}

func (g *Gate) validateMergedRecovery(ctx context.Context, t ledger.Task) error {
	raw, ok, err := Last(ctx, g.DB, t.ID, KindGate)
	if err != nil {
		return err
	}
	var prior gateRecord
	if !ok || json.Unmarshal([]byte(raw), &prior) != nil {
		return api.Conflict("没有可核对的原交付关卡证据")
	}
	failedPR := false
	for _, r := range prior.Results {
		if !r.OK {
			if r.Check != CheckPR {
				return api.Conflict("原关卡还有非 PR 生命周期失败")
			}
			failedPR = true
		}
	}
	if !failedPR || !mergedRecheck(prior.Facts, t.PR) {
		return api.Conflict("原关卡不是同一已合入 PR 的 OPEN 生命周期错配")
	}
	resultID, reply, err := deliveryResult(ctx, g.DB, t.ID)
	if err != nil {
		return err
	}
	gateID, err := lastID(ctx, g.DB, t.ID, KindGate)
	if err != nil {
		return err
	}
	if resultID == 0 || resultID > gateID {
		return api.Conflict("原关卡之后回复已变化，不能沿旧证据恢复")
	}
	word, _, ok := Ending(reply)
	if !ok || (word != "完成" && word != "受阻") {
		return api.Conflict("原回复未完成或读不出结论，不能恢复")
	}
	w, err := mustWorkspace(ctx, g.DB, t.ID)
	if err != nil {
		return err
	}
	repo, err := Slug(ctx, g.R, t.Repo)
	if err != nil {
		return err
	}
	current, err := Collect(ctx, On(g.R, w), w.Dir, repo)
	if err != nil {
		return err
	}
	if !mergedRecheck(current, t.PR) || current.Head != prior.Facts.Head {
		return api.Conflict("当前 head 不是原关卡的同一已合入 head")
	}
	return nil
}
