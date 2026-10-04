package gates

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 同一已登记 PR 的已合入 head 证明代码已应用；默认分支的 squash 差异不再代表新交付。
func mergedRecheck(f Facts, registered string) bool {
	return f.PR != nil && registered != "" && f.PR.URL == registered && f.PR.State == "MERGED" &&
		f.PR.MergeCommit != "" && f.PR.HeadID != "" && f.PR.HeadID == f.Head && f.PR.Head == f.Branch
}

func recheckVerdict(checks []string, f Facts) Verdict {
	v := Verdict{Pass: true}
	for _, c := range checks {
		var r Result
		switch c {
		case CheckFinished:
			r = Result{Check: c, OK: len(f.Dirty) == 0 && f.Pushed, Evidence: "同一已合入 head，工作树干净且已推送"}
			if !r.OK {
				r.Evidence = "已合入复核要求干净工作树且当前 HEAD 已推送"
			}
		case CheckPR:
			r = Result{Check: c, OK: true, Evidence: "原 PR 已合入，复核不再合入"}
		default:
			r = judgeOne(c, f)
		}
		v.Results = append(v.Results, r)
		if !r.OK {
			v.Pass = false
			v.Reasons = append(v.Reasons, c+"："+r.Evidence)
		}
	}
	// 档案不能移除复核的事实边界。
	if len(f.Dirty) > 0 || !f.Pushed {
		v.Pass = false
		v.Reasons = append(v.Reasons, "已合入复核要求干净工作树且当前 HEAD 已推送")
	}
	return v
}

// MergedRecovery 只记在既有 gate 经历里，绑定原回复；不是完成结论或新的生命周期。
type MergedRecovery struct {
	Reason   string `json:"reason"`
	Evidence string `json:"evidence"`
}

// deliveryResult 保留作者交付回复；原任务的审阅轮不会替换作者的完成/受阻结论。
func deliveryResult(ctx context.Context, q store.Querier, id string) (int64, string, error) {
	var n int64
	var body string
	err := q.QueryRowContext(ctx, `SELECT id,body FROM task_events WHERE task=? AND kind='result'
 AND id > (SELECT COALESCE(max(id),0) FROM task_events WHERE task=? AND kind='launch' AND COALESCE(json_extract(body,'$.why'),'') != 'review')
 AND id < (SELECT COALESCE(min(id),9223372036854775807) FROM task_events WHERE task=? AND kind='launch' AND json_extract(body,'$.why')='review'
 AND id > (SELECT COALESCE(max(id),0) FROM task_events WHERE task=? AND kind='launch' AND COALESCE(json_extract(body,'$.why'),'') != 'review'))
 ORDER BY id DESC LIMIT 1`, id, id, id, id).Scan(&n, &body)
	if store.IsNotFound(err) {
		return 0, "", nil
	}
	return n, body, err
}

func (g *Gate) landRecheck(ctx context.Context, t ledger.Task, repo string) (landed, error) {
	w, err := mustWorkspace(ctx, g.DB, t.ID)
	if err != nil {
		return landed{}, err
	}
	f, err := Collect(ctx, On(g.R, w), w.Dir, repo)
	if err != nil {
		return landed{}, err
	}
	if !mergedRecheck(f, t.PR) || len(f.Dirty) > 0 || !f.Pushed {
		return landed{}, api.Conflict("已合入复核的 head、工作树或推送事实已变化")
	}
	raw, ok, err := Last(ctx, g.DB, t.ID, KindGate)
	if err != nil {
		return landed{}, err
	}
	var gate gateRecord
	if !ok || json.Unmarshal([]byte(raw), &gate) != nil || gate.Facts.Head != f.Head {
		return landed{}, api.Conflict("没有本 head 的复核关卡证据")
	}
	n, reply, err := deliveryResult(ctx, g.DB, t.ID)
	if err != nil {
		return landed{}, err
	}
	if n != gate.ResultID {
		return landed{}, api.Conflict("复核原回复已变化，请重新过关卡")
	}
	done, _, ok := ParseEnding(reply)
	if !ok || (!done && gate.Recovery == nil) {
		return landed{}, api.Conflict("复核回复未完成且没有显式恢复授权")
	}
	return landed{note: fmt.Sprintf("原 PR %s 已合入，只读复核验收完成，不再合入", t.PR)}, nil
}
