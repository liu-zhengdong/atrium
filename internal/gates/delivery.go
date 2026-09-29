package gates

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Delivery 是一种交付方式：执行者交什么（Rules，附进提示词）、关卡查什么事实（check）、验收后怎么落地（land）。
// 不存库，按任务已有的事实选（deliveryOf）：有仓库 → pr；没有仓库 → message，工作目录根有 choice.json → choice。
// 核心（ledger）只认关卡、审阅、验收过没过与落地的步骤名；要新的交付方式在这里加一项。
type Delivery struct {
	Name string
	// Rules 是提示词「通用约束」里怎么交；%s 换成执行者的分支。
	Rules []string
	// check 查事实判关卡。
	check func(g *Gate, ctx context.Context, t ledger.Task) (checked, error)
	// land 是落地的第一步（关卡、审阅、验收都过了之后）：返回落地步骤，由别的循环接着推进（如 pr 的合入队列）；
	// 空表示当场落完，任务完成。note 记进经历。
	land func(g *Gate, ctx context.Context, t ledger.Task) (stage ledger.Stage, note string, err error)
}

// checked 是关卡查完的结论。
type checked struct {
	reasons []string // 不过的原因；空为过
	note    string   // 过了记进经历的话
	review  string   // 非空：落地前要另一个模型审阅，写明为什么
}

var noRepoRules = []string{"这件活没有仓库：在当前目录干，交付物是最后一条消息里的结论（写清调查结果与依据）。"}

var (
	// pr：在分支上开 PR；关卡查提交、推送、改动规模与 PR 正文；落地是合入队列（merge）加可选的发版（release）。
	deliverPR = Delivery{Name: "pr",
		Rules: []string{
			"只交 PR：在分支 %s 上提交、推送并开 PR；不要合入、不要改默认分支、不要发版。",
			"PR 正文写「端到端验证」一节：在隔离实例里跑了什么、输出摘要；会停服务、改机器状态的步骤标注「只在隔离环境」。",
		},
		check: (*Gate).checkPR,
		land: func(*Gate, context.Context, ledger.Task) (ledger.Stage, string, error) {
			return ledger.StageMerge, "进合入队列", nil
		}}
	// message：结论写在最后的回复里；关卡只看执行者正常收尾；落地为空。
	deliverMessage = Delivery{Name: "message", Rules: noRepoRules,
		check: func(*Gate, context.Context, ledger.Task) (checked, error) {
			return checked{note: "没有仓库，结论在最后的回复里"}, nil
		},
		land: func(*Gate, context.Context, ledger.Task) (ledger.Stage, string, error) { return "", "", nil }}
	// choice：调研任务在工作目录根写 choice.json；关卡核对格式；落地是登记成选项单（agenda.Settle）。
	deliverChoice = Delivery{Name: "choice", Rules: noRepoRules, check: (*Gate).checkChoice, land: (*Gate).landChoice}
)

// PromptRules 是派活时提示词里怎么交（dispatch 附进「通用约束」）。choice 与 message 派活时分不出来，
// 提示词相同；要不要写 choice.json 由任务详述（调研周期任务）说。
func PromptRules(repo, branch string) []string {
	d := deliverMessage
	if repo != "" {
		d = deliverPR
	}
	out := make([]string, len(d.Rules))
	for i, r := range d.Rules {
		out[i] = strings.ReplaceAll(r, "%s", branch)
	}
	return out
}

// deliveryOf 按任务已有的事实选交付方式。
func (g *Gate) deliveryOf(ctx context.Context, t ledger.Task) (Delivery, error) {
	if t.Repo != "" {
		return deliverPR, nil
	}
	raw, err := g.choiceFile(ctx, t)
	if err != nil || raw == nil {
		return deliverMessage, err
	}
	return deliverChoice, nil
}

// choiceFile 读没有仓库的任务工作目录根的 choice.json（远程经代理）；没登记工作目录或没有文件为 nil。
func (g *Gate) choiceFile(ctx context.Context, t ledger.Task) ([]byte, error) {
	w, found, err := Workspace(ctx, g.DB, t.ID)
	if err != nil || !found {
		return nil, err
	}
	return ReadFile(ctx, w, agenda.ChoiceFile)
}

func (g *Gate) checkChoice(ctx context.Context, t ledger.Task) (checked, error) {
	raw, err := g.choiceFile(ctx, t)
	if err != nil {
		return checked{}, err
	}
	_, err = agenda.ParseChoice(raw)
	if err == nil && t.Org == "" {
		err = api.Usage("%s 没挂部门，%s 无处登记", t.ID, agenda.ChoiceFile)
	}
	var ae *api.Error
	if errors.As(err, &ae) && ae.Code == "usage" {
		return checked{reasons: []string{ae.Message}}, nil
	}
	return checked{note: "没有仓库，交了选项单"}, err
}

func (g *Gate) landChoice(ctx context.Context, t ledger.Task) (ledger.Stage, string, error) {
	raw, err := g.choiceFile(ctx, t)
	if err != nil {
		return "", "", err
	}
	c, err := agenda.Settle(ctx, g.DB, t.ID, raw)
	if err != nil || c == nil {
		return "", "", err
	}
	return "", "登记了选项单 " + c.ID, nil
}

// checkPR 查事实、判关卡：git 在工作树所在机器上查（On），PR 由服务查 GitHub；过了记下 PR，按风险与信任定要不要审阅。
func (g *Gate) checkPR(ctx context.Context, t ledger.Task) (checked, error) {
	w, err := mustWorkspace(ctx, g.DB, t.ID)
	if err != nil {
		return checked{}, err
	}
	prof, err := LoadProfile(ctx, g.DB, t.Worker)
	if err != nil {
		return checked{}, err
	}
	repo, err := Slug(ctx, g.R, t.Repo)
	if err != nil {
		return checked{}, err
	}
	facts, err := Collect(ctx, On(g.R, w), w.Dir, repo)
	if err != nil {
		return checked{}, err
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
		return checked{}, err
	}
	if !v.Pass {
		return checked{reasons: v.Reasons}, nil
	}
	url := facts.PR.URL
	if err := ledger.SetFacts(ctx, g.DB, t.ID, ledger.Facts{PR: &url}, Actor); err != nil {
		return checked{}, err
	}
	risk, err := Risk(ctx, g.DB, t.ID)
	if err != nil {
		return checked{}, err
	}
	c := checked{note: fmt.Sprintf("关卡通过（%s）：%s", strings.Join(checks, "、"), facts.Diff)}
	if need, why := NeedReview(risk, prof.Trust); need {
		c.review = why
	}
	return c, nil
}

// acceptBy 是这件任务过了关卡、审阅之后要等谁验收：部门的验收人（沿树继承），auto 为空。
// 审阅任务是运行时自己建的，不等人验收。
func acceptBy(ctx context.Context, q store.Querier, t ledger.Task) (string, error) {
	if _, review, err := Last(ctx, q, t.ID, KindReviewOf); err != nil || review {
		return "", err
	}
	who, _, err := org.Acceptor(ctx, q, t.Org)
	if err != nil || who == org.AcceptAuto {
		return "", err
	}
	return who, nil
}

var acceptLabel = map[string]string{org.AcceptUser: "你", org.AcceptLeader: "负责人"}

// pass 过了关卡或审阅：部门的验收人是 leader、user 就停在等验收；否则当场落地。
func (g *Gate) pass(ctx context.Context, t ledger.Task, d Delivery, kind ledger.EventKind, note string) error {
	by, err := acceptBy(ctx, g.DB, t)
	if err != nil {
		return err
	}
	if by != "" {
		note += fmt.Sprintf("；等%s验收：atrium task accept %s，或 atrium task reject %s --reason 原因", acceptLabel[by], t.ID, t.ID)
		_, err := ledger.Apply(ctx, g.DB, t.ID, ledger.Event{Kind: kind, AcceptBy: by}, Actor, note)
		return err
	}
	return g.land(ctx, t, d, kind, Actor, note)
}

// land 做交付方式落地的第一步并落账：有后续步骤进那一步，没有任务完成。
func (g *Gate) land(ctx context.Context, t ledger.Task, d Delivery, kind ledger.EventKind, actor, note string) error {
	stage, landed, err := d.land(g, ctx, t)
	if err != nil {
		return err
	}
	if landed != "" {
		note += "；" + landed
	}
	_, err = ledger.Apply(ctx, g.DB, t.ID, ledger.Event{Kind: kind, Land: stage}, actor, note)
	return err
}

// awaiting 取等验收的任务并核对 actor 能不能判：用户与秘书都能；负责人不能代用户验收（管辖由负责人权限另判）。
func (g *Gate) awaiting(ctx context.Context, id, actor string) (ledger.Task, error) {
	t, err := ledger.Get(ctx, g.DB, id)
	if err != nil {
		return t, err
	}
	if t.Status != ledger.Running || t.Stage != ledger.StageAccept {
		return t, api.Conflict("%s 不在等验收（当前 %s/%s）", id, t.Status, t.Stage).WithNext("atrium task show " + id)
	}
	who, _, err := org.Acceptor(ctx, g.DB, t.Org)
	if err != nil {
		return t, err
	}
	if !org.MayAccept(actor, who) {
		return t, api.Forbidden("%s 所在部门的验收人是用户，%s 不能代验；需要就上交", id, actor).
			WithNext("atrium leader escalate <说明> --kind beyond --task " + id)
	}
	return t, nil
}

// Accept 是 task accept：验收通过，做交付方式落地的第一步（pr 进合入队列，choice 登记选项单，message 直接完成）。
func (g *Gate) Accept(ctx context.Context, id, actor string) (ledger.Task, error) {
	t, err := g.awaiting(ctx, id, actor)
	if err != nil {
		return t, err
	}
	d, err := g.deliveryOf(ctx, t)
	if err != nil {
		return t, err
	}
	if err := g.land(ctx, t, d, ledger.Accept, actor, "验收通过（"+actor+"）"); err != nil {
		return t, err
	}
	return ledger.Get(ctx, g.DB, id)
}

// Reject 是 task reject：验收打回，交回原执行者照原因改（与关卡不过同一套计次，第 3 次转受阻）。
func (g *Gate) Reject(ctx context.Context, id, actor, reason string) (ledger.Task, error) {
	if strings.TrimSpace(reason) == "" {
		return ledger.Task{}, api.Usage("--reason: 不能为空（写清哪里不行，执行者照它改）")
	}
	if _, err := g.awaiting(ctx, id, actor); err != nil {
		return ledger.Task{}, err
	}
	return Bounce(ctx, g.DB, id, actor, "验收打回（"+actor+"）："+Clip(reason, 2000))
}
