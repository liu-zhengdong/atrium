// Package gates 是验收关卡：执行者退出后运行时自己查事实（PR、提交、推送、改动规模、PR 正文），
// 按档案 checks 判过或不过，不采信执行者自述；高风险或低信任的交付先另派不同工具、不同模型的审阅者。
//
// 判定在 judge.go（纯函数）；查事实在 facts.go；与 dispatch 的约定在 records.go。
// 结论经 ledger.Apply(GatePass / ReviewPass / Bounce / Block) 落账，理由用 ledger.Record 记进经历。
// merge、release 也用本包的 Runner、ViewPR、Bounce、Paused。
package gates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Actor 是运行时关卡在经历里的署名。
const Actor = "gates"

// Module 是本包接入点：后台循环推进关卡与审阅阶段的任务。
func Module() app.Module {
	return app.Module{Name: "gates", Run: func(ctx context.Context, env *app.Env) error {
		g := &Gate{DB: env.DB, Pause: env.Pause, R: NewExec(), Log: env.Log}
		return g.Loop(ctx)
	}}
}

// Gate 推进 stage 为 gate、review 的任务。
type Gate struct {
	DB    *store.DB
	Pause *pause.Store
	R     Runner
	Log   *slog.Logger
}

// Loop 等账本变化（或每 30 秒）扫一遍。库出错返回错误让服务停下；单件任务出错转受阻。
func (g *Gate) Loop(ctx context.Context) error {
	for {
		ch := ledger.Changed()
		if err := g.Sweep(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ch:
		case <-time.After(30 * time.Second):
		}
	}
}

// InStage 列正在某交付阶段的任务（status running）。
func InStage(ctx context.Context, q store.Querier, stage ledger.Stage) ([]ledger.Task, error) {
	all, err := ledger.List(ctx, q, ledger.Filter{Status: []ledger.Status{ledger.Running}, Limit: 500})
	if err != nil {
		return nil, err
	}
	var out []ledger.Task
	for _, t := range all {
		if t.Stage == stage {
			out = append(out, t)
		}
	}
	return out, nil
}

// Paused 判这件任务所在部门链或机器是否暂停。
func Paused(ctx context.Context, db *store.DB, p *pause.Store, t ledger.Task, host string) (bool, error) {
	var orgs []string
	if t.Org != "" {
		var err error
		if orgs, err = org.Ancestors(ctx, db, t.Org); err != nil {
			return false, err
		}
	}
	return p.Paused(ctx, pause.Scope{Orgs: orgs, Host: host})
}

// Sweep 推进一轮：先关卡，再审阅。
func (g *Gate) Sweep(ctx context.Context) error {
	for _, stage := range []ledger.Stage{ledger.StageGate, ledger.StageReview} {
		tasks, err := InStage(ctx, g.DB, stage)
		if err != nil {
			return err
		}
		for _, t := range tasks {
			if paused, err := Paused(ctx, g.DB, g.Pause, t, t.Host); err != nil || paused {
				if err != nil {
					return err
				}
				continue
			}
			step := g.gate
			if stage == ledger.StageReview {
				step = g.review
			}
			if err := step(ctx, t); err != nil {
				if ctx.Err() != nil {
					return nil
				}
				if berr := BlockOnError(ctx, g.DB, g.Log, t.ID, stageName(stage), err); berr != nil {
					return berr
				}
			}
		}
	}
	return nil
}

func stageName(s ledger.Stage) string {
	if s == ledger.StageReview {
		return "审阅"
	}
	return "关卡"
}

// Block 把任务转受阻并记原因（负责人会收到 task.status 事件）。
func Block(ctx context.Context, db *store.DB, id, reason string) (ledger.Task, error) {
	return ledger.Apply(ctx, db, id, ledger.Event{Kind: ledger.Block}, Actor, reason)
}

// BlockOnError 把单件任务的出错转成受阻；任务已被别人改了状态（409）只记日志。库出错才返回。
func BlockOnError(ctx context.Context, db *store.DB, log *slog.Logger, id, what string, cause error) error {
	_, err := Block(ctx, db, id, fmt.Sprintf("%s出错：%v", what, cause))
	var ae *api.Error
	if errors.As(err, &ae) && ae.Code == "conflict" {
		log.Warn(what+"出错，任务状态已变", "task", id, "err", cause)
		return nil
	}
	return err
}

func record(ctx context.Context, db *store.DB, id, kind string, body any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return ledger.Record(ctx, db, id, kind, Actor, string(raw))
}

type gateRecord struct {
	Verdict
	Facts Facts `json:"facts"`
}

// gate 查事实、判关卡：git 在工作树所在机器上查（On），PR 由服务查 GitHub。没有仓库的任务（调研、审阅）
// 没有 PR 要合：执行者正常收尾即过，工作目录根有 choice.json 就登记成选项单（agenda.Settle；不合法按关卡不过交回执行者改）。
func (g *Gate) gate(ctx context.Context, t ledger.Task) error {
	if t.Repo == "" {
		return g.settle(ctx, t)
	}
	w, err := mustWorkspace(ctx, g.DB, t.ID)
	if err != nil {
		return err
	}
	prof, err := LoadProfile(ctx, g.DB, t.Worker)
	if err != nil {
		return err
	}
	repo, err := Slug(ctx, g.R, t.Repo)
	if err != nil {
		return err
	}
	facts, err := Collect(ctx, On(g.R, w), w.Dir, repo)
	if err != nil {
		return err
	}
	checks := prof.Checks
	if checks == nil {
		checks = DefaultChecks
	}
	v := Judge(checks, facts)
	if v.Pass && (facts.PR == nil || facts.PR.State != "OPEN") {
		v.Pass = false
		v.Reasons = append(v.Reasons, "pr_exists：分支 "+facts.Branch+" 没有开着的 PR，无从合入")
	}
	if err := record(ctx, g.DB, t.ID, KindGate, gateRecord{v, facts}); err != nil {
		return err
	}
	if !v.Pass {
		_, err := Bounce(ctx, g.DB, t.ID, Actor, "关卡没过："+strings.Join(v.Reasons, "；"))
		return err
	}
	url := facts.PR.URL
	if err := ledger.SetFacts(ctx, g.DB, t.ID, ledger.Facts{PR: &url}, Actor); err != nil {
		return err
	}
	risk, err := Risk(ctx, g.DB, t.ID)
	if err != nil {
		return err
	}
	need, why := NeedReview(risk, prof.Trust)
	note := fmt.Sprintf("关卡通过（%s）：%s", strings.Join(checks, "、"), facts.Diff)
	if need {
		note += "；合入前审阅：" + why
	}
	_, err = ledger.Apply(ctx, g.DB, t.ID, ledger.Event{Kind: ledger.GatePass, NeedReview: need}, Actor, note)
	return err
}

// mustWorkspace 取有仓库的任务的工作树登记，没有就报错。
func mustWorkspace(ctx context.Context, q store.Querier, id string) (Worktree, error) {
	w, found, err := Workspace(ctx, q, id)
	if err == nil && !found {
		err = fmt.Errorf("%s 没有工作树登记（经历里没有 %s）", id, KindWorktree)
	}
	return w, err
}

// settle 过没有仓库的任务：不要求工作树；登记过就读它根下的 choice.json（远程经代理读）。
func (g *Gate) settle(ctx context.Context, t ledger.Task) error {
	var raw []byte
	w, found, err := Workspace(ctx, g.DB, t.ID)
	if err == nil && found {
		raw, err = ReadFile(ctx, w, agenda.ChoiceFile)
	}
	if err != nil {
		return err
	}
	c, err := agenda.Settle(ctx, g.DB, t.ID, raw)
	var ae *api.Error
	if errors.As(err, &ae) && ae.Code == "usage" {
		_, err := Bounce(ctx, g.DB, t.ID, Actor, "关卡没过："+ae.Message)
		return err
	}
	if err != nil {
		return err
	}
	note := "没有仓库，无 PR 要合"
	if c != nil {
		note += "；登记了选项单 " + c.ID
	}
	_, err = ledger.Apply(ctx, g.DB, t.ID, ledger.Event{Kind: ledger.GatePass, NoMerge: true}, Actor, note)
	return err
}

// lastID 取某类经历最近一条的 id（没有为 0）。
func lastID(ctx context.Context, q store.Querier, task, kind string) (int64, error) {
	var id int64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(max(id), 0) FROM task_events WHERE task = ? AND kind = ?`, task, kind).Scan(&id)
	return id, err
}

// review 推进审阅阶段：这一轮还没有审阅任务就建一个交给派活；审阅任务结束后读结论。
func (g *Gate) review(ctx context.Context, t ledger.Task) error {
	passedAt, err := lastID(ctx, g.DB, t.ID, string(ledger.GatePass))
	if err != nil {
		return err
	}
	pickedAt, err := lastID(ctx, g.DB, t.ID, KindReviewer)
	if err != nil {
		return err
	}
	if pickedAt < passedAt {
		return g.startReview(ctx, t)
	}
	ref, _, err := Last(ctx, g.DB, t.ID, KindReviewer)
	if err != nil {
		return err
	}
	rt, err := ledger.Get(ctx, g.DB, ref)
	if err != nil {
		return err
	}
	switch rt.Status {
	case ledger.Todo, ledger.Queued, ledger.Running:
		return nil
	case ledger.Done:
	default:
		_, err := Block(ctx, g.DB, t.ID, fmt.Sprintf("审阅任务 %s 状态 %s，没给出结论", rt.ID, rt.Status))
		return err
	}
	result, _, err := Last(ctx, g.DB, rt.ID, KindResult)
	if err != nil {
		return err
	}
	pass, notes, ok := ParseReview(result)
	if !ok {
		_, err := Block(ctx, g.DB, t.ID, fmt.Sprintf("审阅任务 %s 最后一行没写「审阅结论：通过/打回」", rt.ID))
		return err
	}
	reqBody, _, err := Last(ctx, g.DB, rt.ID, KindRequire)
	if err != nil {
		return err
	}
	var req Requirement
	if err := json.Unmarshal([]byte(reqBody), &req); err != nil {
		return fmt.Errorf("审阅任务 %s 的执行者要求坏了：%w", rt.ID, err)
	}
	reviewer, err := LoadProfile(ctx, g.DB, rt.Worker)
	if err != nil {
		return err
	}
	if why := req.Refusal(reviewer); why != "" {
		_, err := Block(ctx, g.DB, t.ID, fmt.Sprintf("审阅任务 %s 的审阅者不合格：%s", rt.ID, why))
		return err
	}
	if err := record(ctx, g.DB, t.ID, KindReview, map[string]any{"reviewer": rt.ID, "worker": rt.Worker, "pass": pass, "notes": notes}); err != nil {
		return err
	}
	if pass {
		_, err := ledger.Apply(ctx, g.DB, t.ID, ledger.Event{Kind: ledger.ReviewPass}, Actor, "审阅通过（"+rt.ID+"，"+rt.Worker+"）")
		return err
	}
	if notes == "" {
		notes = "审阅者没写具体问题"
	}
	_, err = Bounce(ctx, g.DB, t.ID, Actor, fmt.Sprintf("审阅打回（%s，%s）：%s", rt.ID, rt.Worker, notes))
	return err
}

func (g *Gate) startReview(ctx context.Context, t ledger.Task) error {
	author, err := LoadProfile(ctx, g.DB, t.Worker)
	if err != nil {
		return err
	}
	w, err := mustWorkspace(ctx, g.DB, t.ID)
	if err != nil {
		return err
	}
	repo, err := Slug(ctx, g.R, t.Repo)
	if err != nil {
		return err
	}
	pr, err := ViewPR(ctx, g.R, repo, t.PR)
	if err != nil {
		return err
	}
	risk, err := Risk(ctx, g.DB, t.ID)
	if err != nil {
		return err
	}
	_, why := NeedReview(risk, author.Trust)
	var last gateRecord
	if body, ok, err := Last(ctx, g.DB, t.ID, KindGate); err != nil {
		return err
	} else if ok {
		json.Unmarshal([]byte(body), &last)
	}
	dir := w.Dir
	if w.Remote() {
		dir = ""
	}
	brief := ReviewBrief(t.ID, t.Title, repo, pr.PR, dir, pr.Base, why, last.Facts.Diff, t.Detail)
	rt, err := ledger.Add(ctx, g.DB, ledger.NewTask{Title: Clip("审阅 "+t.ID+"："+t.Title, 200), Detail: brief,
		Parent: t.ID, Org: t.Org, Priority: t.Priority}, Actor)
	if err != nil {
		return err
	}
	req := Requirement{NotTool: author.Tool, NotModel: author.Model, MinTrust: "medium"}
	if err := record(ctx, g.DB, rt.ID, KindRequire, req); err != nil {
		return err
	}
	if err := ledger.Record(ctx, g.DB, rt.ID, KindReviewOf, Actor, t.ID); err != nil {
		return err
	}
	if err := ledger.Record(ctx, g.DB, t.ID, KindReviewer, Actor, rt.ID); err != nil {
		return err
	}
	if Enqueue == nil {
		return errors.New("派活没接上（gates.Enqueue 由 dispatch 装配）")
	}
	return Enqueue(ctx, rt.ID, Actor)
}

// Clip 按字符截断。
func Clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
