package workers

import (
	"context"
	"fmt"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"time"
)

func finishLeader(ctx context.Context, env *app.Env, r Resolved, log string, code int, confirmed bool) (bool, string, error) {
	sig := Classify(code, r.ID, LogTail{Text: log}, time.Now())
	if sig.Kind == SignalNone {
		p := NewParser(r.ID)
		p.Feed(log)
		tr := p.Trace()
		if r.Rules.Usage != nil {
			tr.Usage = ExtractUsage(log, *r.Rules.Usage)
		}
		if Silent(tr, confirmed) {
			sig = Signal{Kind: SignalNoStart, Reason: "静默空转：完整零 usage，且无有效动作或确认"}
		}
	}
	m, blocked := MarkOf(sig, r.Spec, quota.LocalHost, time.Now())
	if !blocked {
		return false, sig.Reason, nil
	}
	if err := SetMark(ctx, env.DB, m); err != nil {
		return false, "", err
	}
	if sig.Kind == SignalQuota && r.QuotaBinding != nil {
		if err := markLeaderPool(ctx, env, r, m); err != nil {
			return false, "", err
		}
	}
	return true, m.Reason, nil
}

// 复用现有 marks：仅当前本机解析证实的同池成员共享原失败与期限，不建关联表。
func markLeaderPool(ctx context.Context, env *app.Env, failed Resolved, m Mark) error {
	marks, err := Marks(ctx, env.DB, m.Since)
	if err != nil {
		return err
	}
	var count int
	if err := env.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM worker_marks WHERE until=0 OR until>?`, m.Since).Scan(&count); err != nil {
		return err
	}
	if count != len(marks) {
		return fmt.Errorf("共享池标记列表不完整：%d/%d", len(marks), count)
	}
	targets := map[string]bool{}
	for _, existing := range marks {
		targets[existing.Target()] = true
	}
	pending, err := PlanPoolMarks(ctx, env, failed.QuotaBinding, m, []string{quota.LocalHost}, targets)
	if err != nil {
		return err
	}
	for _, member := range pending {
		if err := SetMark(ctx, env.DB, member); err != nil {
			return err
		}
	}
	return nil
}
