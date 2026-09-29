// Package gates 是验收关卡：执行者退出后运行时自己查事实（PR、提交、推送、改动规模、PR 正文），
// 按档案 checks 判过或不过，不采信执行者自述；高风险或低信任的交付先另派不同工具、不同模型的审阅者；
// 部门的验收人是 leader、user 时停在等验收，由 task accept / task reject 判。
//
// 交付方式（pr、local、choice、message：怎么交、查什么、怎么落地）在 delivery.go（local 的关卡与落地在 local.go）；判定在 judge.go（纯函数）；
// 查事实在 facts.go；与 dispatch 的约定在 records.go。
// 结论经 ledger.Apply(GatePass / ReviewPass / Accept / Bounce / Block) 落账，理由用 ledger.Record 记进经历。
// merge、release 也用本包的 Runner、ViewPR、Bounce、Paused。
package gates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Actor 是运行时关卡在经历里的署名。
const Actor = "gates"

// Module 是本包接入点：后台循环推进关卡与审阅阶段的任务；task accept / task reject 判等验收的任务。
func Module() app.Module {
	return app.Module{Name: "gates", Commands: Commands, Routes: Routes,
		Run: func(ctx context.Context, env *app.Env) error {
			g := &Gate{DB: env.DB, Data: env.Paths.Data, Pause: env.Pause, R: NewExec(), Log: env.Log}
			return g.Loop(ctx)
		}}
}

func Commands(t *cli.Table) {
	t.Add(cli.Command{Path: "task accept", Args: "<tN>", Summary: "验收通过：等验收的交付落地（有 GitHub 仓库进合入队列，本机仓库合进本机主分支，调研登记选项单，其余直接完成）",
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<tN>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			var t ledger.Task
			if err := c.Call("POST", "/api/tasks/"+url.PathEscape(id)+"/accept", struct{}{}, &t); err != nil {
				return err
			}
			switch t.Status {
			case ledger.Done:
				return c.Done(t, fmt.Sprintf("%s「%s」验收通过，已完成", t.ID, t.Title), "atrium task show "+t.ID)
			case ledger.Queued, ledger.Blocked:
				return c.Done(t, fmt.Sprintf("%s「%s」验收通过但落地没成，已交回（%s）", t.ID, t.Title, t.Status), "atrium task show "+t.ID)
			}
			text, next, err := events.AsyncNext(c, fmt.Sprintf("%s「%s」验收通过，落地中（%s）", t.ID, t.Title, t.Stage), "atrium task wait "+t.ID)
			if err != nil {
				return err
			}
			return c.Done(t, text, next)
		}})
	t.Add(cli.Command{Path: "task reject", Args: "<tN>", Summary: fmt.Sprintf("验收打回：交回原执行者照原因改（第 %d 次转受阻）", ledger.MaxBounces+1),
		Flags: []cli.Flag{{Name: "reason", Value: "文字", Help: "哪里不行、要改成什么（必填，附进执行者的提示词）"}},
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<tN>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			var t ledger.Task
			if err := c.Call("POST", "/api/tasks/"+url.PathEscape(id)+"/reject", RejectBody{Reason: c.Str("reason")}, &t); err != nil {
				return err
			}
			if t.Status == ledger.Blocked {
				return c.Done(t, fmt.Sprintf("%s「%s」打回次数用尽，转受阻", t.ID, t.Title), "atrium task show "+t.ID)
			}
			return c.Done(t, fmt.Sprintf("%s「%s」已打回，交回原执行者重做", t.ID, t.Title), "atrium task log "+t.ID+" --follow")
		}})
}

// RejectBody 是 POST /api/tasks/{id}/reject。
type RejectBody struct {
	Reason string `json:"reason"`
}

func Routes(r *api.Router, env *app.Env) {
	g := &Gate{DB: env.DB, Data: env.Paths.Data, Pause: env.Pause, R: NewExec(), Log: env.Log}
	r.Handle("POST /api/tasks/{id}/accept", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "t")
		if err != nil {
			return nil, err
		}
		var in struct{}
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return g.Accept(q.Context(), id, q.Actor.ID)
	})
	r.Handle("POST /api/tasks/{id}/reject", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "t")
		if err != nil {
			return nil, err
		}
		var in RejectBody
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return g.Reject(q.Context(), id, q.Actor.ID, in.Reason)
	})
}

// Gate 推进 stage 为 gate、review 的任务。
type Gate struct {
	DB    *store.DB
	Data  string // 数据目录（用于计算 tasks/tN 产物目录）
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

// gate 按交付方式查事实、判关卡：不过交回执行者；过了按风险先审阅，或按部门的验收人等验收，或直接落地。
func (g *Gate) gate(ctx context.Context, t ledger.Task) error {
	d, err := g.deliveryOf(ctx, t)
	if err != nil {
		return err
	}
	c, err := d.check(g, ctx, t)
	if err != nil {
		return err
	}
	if len(c.reasons) > 0 {
		_, err := Bounce(ctx, g.DB, t.ID, Actor, "关卡没过："+strings.Join(c.reasons, "；"))
		return err
	}

	// 跑任务挂载技能声明的交付检查项
	if t.Skill != "" {
		sc, err := g.runSkillChecks(ctx, t)
		if err != nil {
			return err
		}
		if len(sc.reasons) > 0 {
			_, err := Bounce(ctx, g.DB, t.ID, Actor, "关卡没过："+strings.Join(sc.reasons, "；"))
			return err
		}
		if sc.note != "" {
			if c.note != "" {
				c.note += "；" + sc.note
			} else {
				c.note = sc.note
			}
		}
	}

	if c.review != "" {
		_, err := ledger.Apply(ctx, g.DB, t.ID, ledger.Event{Kind: ledger.GatePass, NeedReview: true}, Actor, c.note+"；落地前审阅："+c.review)
		return err
	}
	return g.pass(ctx, t, d, ledger.GatePass, c.note)
}

func (g *Gate) taskDir(taskID string) string {
	if g.Data != "" {
		return filepath.Join(g.Data, "tasks", taskID)
	}
	return filepath.Join(os.TempDir(), "atrium-tasks", taskID)
}

func (g *Gate) runSkillChecks(ctx context.Context, t ledger.Task) (checked, error) {
	if t.Skill == "" {
		return checked{}, nil
	}
	s, err := org.GetSkill(ctx, g.DB, g.Data, t.Skill)
	if err != nil {
		return checked{}, err
	}
	if len(s.Checks) == 0 {
		return checked{}, nil
	}

	w, _, err := Workspace(ctx, g.DB, t.ID)
	if err != nil {
		return checked{}, err
	}
	workDir := w.Dir
	if workDir == "" {
		if t.Dir != "" {
			workDir = t.Dir
		} else {
			workDir = filepath.Join(g.taskDir(t.ID), "work")
		}
	}
	taskDir := g.taskDir(t.ID)
	if err := os.MkdirAll(taskDir, 0o700); err != nil {
		return checked{}, err
	}

	cctx := CheckContext{
		Context: ctx,
		Task:    t,
		WorkDir: workDir,
		TaskDir: taskDir,
		Runner:  On(g.R, w),
		DB:      g.DB,
		Data:    g.Data,
		Log:     g.Log,
	}

	_, allPassed, reasons, allArtifacts, err := RunSkillChecks(cctx, s.Checks)
	if err != nil {
		return checked{}, err
	}

	// 产物路径逐条记进任务经历，供负责人审和 task show 给出
	for _, a := range allArtifacts {
		if err := ledger.Record(ctx, g.DB, t.ID, KindArtifacts, Actor, a); err != nil {
			return checked{}, err
		}
	}

	if !allPassed {
		return checked{reasons: reasons}, nil
	}
	note := "技能检查通过（" + strings.Join(s.Checks, "、") + "）"
	if len(allArtifacts) > 0 {
		note += "；产物：" + strings.Join(allArtifacts, "、")
	}
	return checked{note: note}, nil
}

// mustWorkspace 取有仓库的任务的工作树登记，没有就报错。
func mustWorkspace(ctx context.Context, q store.Querier, id string) (Worktree, error) {
	w, found, err := Workspace(ctx, q, id)
	if err == nil && !found {
		err = fmt.Errorf("%s 没有工作树登记（经历里没有 %s）", id, KindWorktree)
	}
	return w, err
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
		d, err := g.deliveryOf(ctx, t)
		if err != nil {
			return err
		}
		return g.pass(ctx, t, d, ledger.ReviewPass, "审阅通过（"+rt.ID+"，"+rt.Worker+"）")
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
