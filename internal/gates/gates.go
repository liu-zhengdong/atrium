// Package gates 是交付检查与验收：执行者退出后运行时自己查事实（PR、提交、推送、改动规模、PR 正文），
// 按档案 checks 判过或不过。执行者自称完成不算数；自称受阻即停车交处理人（转受阻），自称没做成、未完成照信，交回重做。
// 高风险或低信任的交付先另派不同工具、不同模型的审阅者；
// 部门的验收人是 leader、user 时停在等验收，由 task accept / task reject 判。
//
// 交付方式（pr、local、choice、message：怎么交、查什么、怎么应用）在 delivery.go（local 的交付检查与应用在 local.go）；
// 档案 checks 的判定在 judge.go（纯函数）；PR 草稿与交付结论的准入在 admit.go（纯函数，进合入队列前再跑）；
// 查事实在 facts.go；与 dispatch 的约定在 records.go。
// 结论经 ledger.Apply(GatePass / ReviewPass / Accept / Bounce / Block) 记录结果，理由用 ledger.Record 记进经历。
// merge、release 也用本包的 Runner、ViewPR、Bounce、Paused。
package gates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/gates/skillcheck"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Actor 是运行时交付检查在经历里的署名。
const Actor = "gates"

// Module 是本包接入点：后台循环推进入交付检查与审阅阶段的任务；task accept / task reject 判等验收的任务。
func Module() app.Module {
	return app.Module{Name: "gates", Commands: Commands, Routes: Routes,
		Run: func(ctx context.Context, env *app.Env) error {
			g := &Gate{DB: env.DB, Data: env.Paths.Data, Pause: env.Pause, R: NewExec(), Log: env.Log}
			return g.Loop(ctx)
		}}
}

func Commands(t *cli.Table) {
	t.Add(cli.Command{Path: "task accept", Args: "<tN>", Summary: "验收通过：应用验收通过的交付结果（有 GitHub 仓库进合入队列，本机仓库合进本机主分支，调研登记选项单，其余直接完成）",
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
				return c.Done(t, fmt.Sprintf("%s「%s」验收通过但应用交付结果失败，已交回（%s）", t.ID, t.Title, t.Status), "atrium task show "+t.ID)
			}
			text, next, err := events.AsyncNext(c, fmt.Sprintf("%s「%s」验收通过，正在应用交付结果（%s）", t.ID, t.Title, t.Stage), "atrium task wait "+t.ID)
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
	Data  string // 数据目录：读技能、技能检查的产物放 tasks/<任务>/
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
	return inStage(ctx, q, stage, ledger.Running)
}

func inStage(ctx context.Context, q store.Querier, stage ledger.Stage, status ...ledger.Status) ([]ledger.Task, error) {
	all, err := ledger.List(ctx, q, ledger.Filter{Status: status, Limit: 500})
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

// Sweep 推进一轮：先交付检查，再审阅（含审阅阶段受阻的，见 review）。
func (g *Gate) Sweep(ctx context.Context) error {
	for _, stage := range []ledger.Stage{ledger.StageGate, ledger.StageReview} {
		status := []ledger.Status{ledger.Running}
		if stage == ledger.StageReview {
			status = append(status, ledger.Blocked)
		}
		tasks, err := inStage(ctx, g.DB, stage, status...)
		if err != nil {
			return err
		}
		err = ledger.EachTask(ctx, g.DB, "gates."+string(stage), tasks, func(t ledger.Task) string { return t.ID }, func(t ledger.Task) error {
			if paused, err := Paused(ctx, g.DB, g.Pause, t, t.Host); err != nil || paused {
				return err
			}
			if stage == ledger.StageReview {
				return g.review(ctx, t)
			}
			return g.gate(ctx, t)
		})
		if err != nil {
			return err
		}

	}
	return nil
}

// Block 把任务转受阻并记原因（负责人会收到 task.status 事件）。
func Block(ctx context.Context, db *store.DB, id, reason string) (ledger.Task, error) {
	return ledger.Apply(ctx, db, id, ledger.Event{Kind: ledger.Block}, Actor, reason)
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

// gate 按交付方式查事实、判定交付检查结果：不过交回执行者；过了按风险先审阅，或按部门的验收人等验收，或直接应用。
func (g *Gate) gate(ctx context.Context, t ledger.Task) error {
	d, err := g.deliveryOf(ctx, t, true)
	if err != nil {
		return err
	}
	c, err := d.check(g, ctx, t)
	if err != nil {
		// 错误带上下文，gh/git 的临时失败经 EachTask 记重试；不包直接转受阻。
		return fmt.Errorf("查交付事实（%s）：%w", t.ID, err)
	}
	if len(c.reasons) > 0 {
		_, err := Bounce(ctx, g.DB, t.ID, Actor, "交付检查未通过："+strings.Join(c.reasons, "；"))
		return err
	}
	if c.block != "" {
		_, err := Block(ctx, g.DB, t.ID, c.block)
		return err
	}

	sc, err := g.skillChecks(ctx, t)
	if err != nil {
		return err
	}
	if len(sc.reasons) > 0 {
		_, err := Bounce(ctx, g.DB, t.ID, Actor, "交付检查未通过："+strings.Join(sc.reasons, "；"))
		return err
	}
	if sc.note != "" {
		c.note = strings.TrimPrefix(c.note+"；"+sc.note, "；")
	}
	if c.review != "" {
		_, err := ledger.Apply(ctx, g.DB, t.ID, ledger.Event{Kind: ledger.GatePass, NeedReview: true}, Actor, c.note+"；应用前审阅："+c.review)
		return err
	}
	return g.pass(ctx, t, d, ledger.GatePass, c.note)
}

// skillChecks 跑任务所挂技能声明的交付检查（skillcheck），每项结论与产物路径记进经历；没挂技能或技能没声明时为空。
// 检查只在本机跑：工作目录在远程机器上时出错（转受阻），不交回执行者。
func (g *Gate) skillChecks(ctx context.Context, t ledger.Task) (checked, error) {
	if t.Skill == "" {
		return checked{}, nil
	}
	s, err := org.GetSkill(ctx, g.DB, t.Skill)
	if err != nil || len(s.Checks) == 0 {
		return checked{}, err
	}
	w, err := mustWorkspace(ctx, g.DB, t.ID)
	if err != nil {
		return checked{}, err
	}
	if w.Remote() {
		return checked{}, fmt.Errorf("技能 %s 的交付检查暂只支持本机，工作目录在 %s 上", s.Name, w.Host)
	}
	rs, err := skillcheck.Run(ctx, skillcheck.Env{Dir: w.Dir, Out: filepath.Join(g.Data, "tasks", t.ID), R: g.R}, s.Checks)
	if err != nil {
		return checked{}, fmt.Errorf("技能 %s：%w", s.Name, err)
	}
	var c checked
	for _, r := range rs {
		if err := ledger.Record(ctx, g.DB, t.ID, KindSkillCheck, Actor, r.String()); err != nil {
			return checked{}, err
		}
		for _, a := range r.Artifacts {
			if err := ledger.Record(ctx, g.DB, t.ID, KindArtifact, Actor, a); err != nil {
				return checked{}, err
			}
		}
		if !r.OK {
			c.reasons = append(c.reasons, r.Check+"："+r.Evidence)
		}
	}
	if len(c.reasons) == 0 {
		c.note = "技能检查通过：" + strings.Join(s.Checks, "、")
	}
	return c, nil
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

// review 推进审阅阶段：这一轮还没有审阅任务就建一个交给分派任务；审阅任务结束后读结论。
// 审阅阶段受阻的任务（多是审阅任务失败）只在审阅任务之后重跑出结论时接着按结论走。
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
		if t.Status == ledger.Blocked {
			return nil // 建审阅任务时出错受阻，等人处理
		}
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
	if t.Status == ledger.Blocked && (rt.Status != ledger.Done || rt.FinishedAt == nil || *rt.FinishedAt <= t.UpdatedAt) {
		return nil // 受阻之后审阅任务没再完成过：结论已经用过或还没有
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
		d, err := g.deliveryOf(ctx, t, false)
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
	detail, _, err := ledger.Brief(ctx, g.DB, t)
	if err != nil {
		return err
	}
	brief := ReviewBrief(t.ID, t.Title, repo, pr.PR, dir, pr.Base, why, last.Facts.Diff, detail)
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
		return errors.New("分派任务没接上（gates.Enqueue 由 dispatch 装配）")
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
