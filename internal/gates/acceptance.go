package gates

import (
	"context"
	"fmt"
	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
	"strings"
)

// acceptBy 是这件任务过了交付检查、审阅之后要等谁验收：部门的验收人（沿树继承），auto 为空。
// 没有应用的交付方式（dir、message）和运行时自己建的审阅任务不等人验收。
func acceptBy(ctx context.Context, q store.Querier, t ledger.Task, d Delivery) (string, error) {
	if a, err := ledger.AcceptanceOf(ctx, q, t.ID); err != nil || a != nil {
		if err != nil {
			return "", err
		}
		who, _, err := org.Acceptor(ctx, q, t.Org)
		if err != nil || who == org.AcceptUser {
			return who, err
		}
		return org.AcceptLeader, nil
	}
	if d.land == nil {
		return "", nil
	}
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

// pass 过了交付检查或审阅：要等验收（acceptBy）就停在等验收；否则当场应用。
func (g *Gate) pass(ctx context.Context, t ledger.Task, d Delivery, kind ledger.EventKind, note string) error {
	by, err := acceptBy(ctx, g.DB, t, d)
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

// land 做交付方式应用的第一步并记录结果：有后续步骤进那一步，没有任务完成；无法应用交回原执行者。
func (g *Gate) land(ctx context.Context, t ledger.Task, d Delivery, kind ledger.EventKind, actor, note string) error {
	return ledger.Application(ctx, g.DB, func(ctx context.Context) error { return g.applyDelivery(ctx, t, d, kind, actor, note) })
}

func (g *Gate) applyDelivery(ctx context.Context, t ledger.Task, d Delivery, kind ledger.EventKind, actor, note string) error {
	epoch, err := ledger.DeliveryEpoch(ctx, g.DB, t.ID)
	if err != nil {
		return err
	}
	a, err := ledger.AcceptanceOf(ctx, g.DB, t.ID)
	if err != nil {
		return err
	}
	if a != nil && kind != ledger.Accept {
		by, err := acceptBy(ctx, g.DB, t, d)
		if err != nil {
			return err
		}
		_, err = ledger.Apply(ctx, g.DB, t.ID, ledger.Event{Kind: kind, AcceptBy: by}, actor, note)
		return err
	}
	head := ""
	if a != nil {
		if err := ledger.MayDecide(ctx, g.DB, a, actor); err != nil {
			return err
		}
		head, err = g.deliveryHead(ctx, t, d)
		if err != nil {
			return err
		}
	}
	var l landed
	if d.land != nil {
		var err error
		if l, err = d.land(g, ctx, t); err != nil {
			return err
		}
	}
	if l.bounce != "" {
		_, err := Bounce(ctx, g.DB, t.ID, actor, note+"；应用交付结果失败："+l.bounce)
		return err
	}
	if l.block != "" {
		_, err := Block(ctx, g.DB, t.ID, note+"；"+l.block)
		return err
	}
	if l.note != "" {
		note += "；" + l.note
	}
	_, err = ledger.Apply(ctx, g.DB, t.ID, ledger.Event{Kind: kind, Land: l.stage, Epoch: epoch, Head: head}, actor, note)
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
	if a, err := ledger.AcceptanceOf(ctx, g.DB, id); err != nil || a != nil {
		if err != nil {
			return t, err
		}
		if err := ledger.MayDecide(ctx, g.DB, a, actor); err != nil {
			return t, err
		}
	}
	who, _, err := org.Acceptor(ctx, g.DB, t.Org)
	if err != nil {
		return t, err
	}
	if !org.MayAccept(actor, who) {
		return t, api.Forbidden("%s 所在部门的验收人是用户，%s 不能代验；需要就上报", id, actor).
			WithNext("atrium leader escalate <说明> --kind beyond --task " + id)
	}
	return t, nil
}

// Accept 是 task accept：验收通过，做交付方式应用的第一步（pr 进合入队列，local 合进本机主分支，choice 登记选项单）。
func (g *Gate) Accept(ctx context.Context, id, actor string) (ledger.Task, error) {
	var result ledger.Task
	err := ledger.Application(ctx, g.DB, func(ctx context.Context) error { var err error; result, err = g.accept(ctx, id, actor); return err })
	return result, err
}

func (g *Gate) accept(ctx context.Context, id, actor string) (ledger.Task, error) {
	t, err := g.awaiting(ctx, id, actor)
	if err != nil {
		return t, err
	}
	d, err := g.deliveryOf(ctx, t, false)
	if err != nil {
		return t, err
	}
	if err := g.land(ctx, t, d, ledger.Accept, actor, "验收通过（"+actor+"）"); err != nil {
		return t, err
	}
	return ledger.Get(ctx, g.DB, id)
}

// Reject 是 task reject：验收打回，交回原执行者照原因改（与交付检查未通过同一套计次，第 3 次转受阻）。
func (g *Gate) Reject(ctx context.Context, id, actor, reason string) (ledger.Task, error) {
	if strings.TrimSpace(reason) == "" {
		return ledger.Task{}, api.Usage("--reason: 不能为空（写清哪里不行，执行者照它改）")
	}
	if _, err := g.awaiting(ctx, id, actor); err != nil {
		return ledger.Task{}, err
	}
	return Bounce(ctx, g.DB, id, actor, "验收打回（"+actor+"）："+Clip(reason, 2000))
}

func (g *Gate) deliveryHead(ctx context.Context, t ledger.Task, d Delivery) (string, error) {
	if d.Name != "pr" {
		return "", nil
	}
	repo, err := Slug(ctx, g.R, t.Repo)
	if err != nil {
		return "", err
	}
	pr, err := ViewPR(ctx, g.R, repo, t.PR)
	if err != nil {
		return "", err
	}
	if pr.State != "OPEN" || pr.HeadID == "" {
		return "", api.Conflict("验收要求开着的 PR 与有效 head")
	}
	return pr.HeadID, nil
}
