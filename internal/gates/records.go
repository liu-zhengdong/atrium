package gates

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 与 dispatch 的约定（都记在任务经历 task_events 里，取最近一条）：
//
//	worktree        dispatch 拉起作者轮时记 Worktree：{"host":"hN","dir":"<那台上的绝对路径>"}；交付检查按 host 查事实
//	risk            task run --risk 记：high / medium / low（没记按 low）
//	result          执行者退出时记它最后的回复原文；审阅结论从这里读
//	worker_require  gates 进审阅阶段时记在原任务上（Requirement 的 JSON）；dispatch 挑审阅执行者时按它排除，只对审阅轮生效
const (
	KindWorktree = "worktree"
	KindRisk     = "risk"
	KindResult   = "result"
	KindRequire  = "worker_require"
	KindReviewer = "reviewer" // 原任务上：每次审阅轮拉起记一条 {"worker":…}（本轮的审阅执行者）
	KindGate     = "gate"     // 交付检查结论（Verdict JSON）
	KindReview   = "review"   // 审阅结论
	KindMerge    = "merge"    // 合入队列的经过：冲突文件、检查没过的摘要、跳过检查
	// KindMergeCommit 是合入后 merge 记的 {"pr","commit"}；release 据此等含它的版本。
	KindMergeCommit = "merge_commit"
	// KindSkillCheck 是一项技能检查的结论（一行人话）；KindArtifact 是它生成的一个产物（截图、联系表）的绝对路径，
	// 一条一个，task show 里负责人能看全、直接打开。
	KindSkillCheck = "skill_check"
	KindArtifact   = "artifact"
)

// Last 取一件任务某类经历的最近一条正文；没有时 found=false。
func Last(ctx context.Context, q store.Querier, task, kind string) (body string, found bool, err error) {
	err = q.QueryRowContext(ctx, `SELECT body FROM task_events WHERE task = ? AND kind = ? ORDER BY id DESC LIMIT 1`,
		task, kind).Scan(&body)
	if store.IsNotFound(err) {
		return "", false, nil
	}
	return body, err == nil, err
}

// Worktree 是工作树登记：执行者在哪台机器（本机为 hosts.Local）的哪个目录干活。本机与远程都记它。
type Worktree struct {
	Host string `json:"host"`
	Dir  string `json:"dir"`
}

// Remote 判工作树是否在远程机器上（查事实要经那台的代理）。
func (w Worktree) Remote() bool { return w.Host != hosts.Local }

// Workspace 取执行者的工作树登记；没登记过 found=false。
func Workspace(ctx context.Context, q store.Querier, task string) (w Worktree, found bool, err error) {
	body, ok, err := Last(ctx, q, task, KindWorktree)
	if err != nil || !ok {
		return w, false, err
	}
	if err := json.Unmarshal([]byte(body), &w); err != nil || w.Host == "" || w.Dir == "" {
		return w, false, fmt.Errorf("%s 的工作树登记不是 {\"host\":…,\"dir\":…}：%s", task, body)
	}
	return w, true, nil
}

// Risk 取任务风险；没记按 low。
func Risk(ctx context.Context, q store.Querier, task string) (string, error) {
	body, ok, err := Last(ctx, q, task, KindRisk)
	if err != nil || !ok {
		return "low", err
	}
	return strings.TrimSpace(body), nil
}

// Profile 是交付检查要的档案事实：工具、模型、信任、checks。
type Profile struct {
	Name   string
	Tool   string
	Model  string
	Trust  string
	Checks []string // nil 表示档案没写，按 DefaultChecks
}

// LoadProfile 按执行者标识（任务上记的「工具+模型[:强度]」）取三层叠加后的档案事实（workers.Resolve）。
func LoadProfile(ctx context.Context, q store.Querier, worker string) (Profile, error) {
	r, err := workers.Resolve(ctx, q, worker)
	if err != nil {
		return Profile{}, err
	}
	return Profile{Name: r.ID, Tool: r.Spec.Tool, Model: r.Spec.Model, Trust: r.Rules.EffectiveTrust(), Checks: r.Rules.Checks}, nil
}

// Review 请分派任务在原任务上拉起一轮审阅（dispatch.Review，dispatch 装配时接上）。
// who 空：按 worker_require 挑审阅执行者（不同工具、不同模型、trust 够、不是作者）；非空：交回这位审阅者重审。
// 能审的都忙时静默返回，gates.Sweep 下一轮再试；拉起失败返回错误。
var Review func(ctx context.Context, id, who string) error

// Bounce 交回原执行者（同工作树同分支重派）：记原因、按次数转 queued 或 blocked。
// 转 queued 的由 dispatch 按上次拉起的执行者、风险与凭据重派，不另写队列行。
func Bounce(ctx context.Context, db *store.DB, id, actor, reason string) (ledger.Task, error) {
	return ledger.Apply(ctx, db, id, ledger.Event{Kind: ledger.Bounce}, actor, reason)
}
