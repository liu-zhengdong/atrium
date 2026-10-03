package dispatch

import (
	"cmp"
	"context"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/workers"
	"os"
	"time"
)

func (d *dispatcher) exited(ctx context.Context, p *proc, code int) error {
	db := d.env.DB
	t, err := ledger.Get(ctx, db, p.task)
	if err != nil {
		return err
	}
	last, err := workers.LastRun(ctx, db, p.task)
	if err != nil {
		return err
	}
	if t.Status != ledger.Running || t.Stage != ledger.StageNone || last == nil || last.N != p.run.N {
		return recordExit(ctx, db, p.task, p.run, workers.Exit{N: p.run.N, Reason: "任务已停止或进入下一阶段"})
	}
	log, err := workers.Tail(p.run.Log, workers.TailBytes)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	head, err := readHead(p.run.Log, 64*1024)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	pending, err := tells(ctx, db, p.task, p.run.TellsUpto)
	if err != nil {
		return err
	}
	runs, err := workers.Runs(ctx, db, p.task, 50)
	if err != nil {
		return err
	}
	same, switches, tried := tries(runs)
	sig := workers.Classify(code, p.run.Worker, log, time.Now())
	if sig.Kind == workers.SignalNone && p.stopReason() == "" {
		tr, err := workers.ReadTrace(p.run.Worker, p.run.Log)
		if err != nil {
			return err
		}
		delivered := false
		if workers.Silent(tr, false) {
			delivered, err = hasRunDelivery(ctx, db, p.task, p.run)
			if err != nil {
				return err
			}
		}
		if workers.Silent(tr, delivered) {
			sig = workers.Signal{Kind: workers.SignalNoStart, Reason: "静默空转：完整零 usage，且无有效动作或产出"}

		}
	}
	if p.lost {
		sig = workers.Signal{Kind: workers.SignalTransient, Reason: "远程执行者退出不明"}
	}
	session := p.adapter.SessionOf(head)
	route := RouteExit(ExitInput{Code: code, Signal: sig, Ending: p.adapter.Ended(log.Text), StopFor: p.stopReason(),
		Same: same, Switches: switches, Pending: len(pending), CanResume: p.adapter.CanResume() && session != ""})
	live, err := ledger.Get(ctx, db, p.task)
	if err != nil {
		return err
	}
	if live.Status != ledger.Running || live.Stage != ledger.StageNone {
		return recordExit(ctx, db, p.task, p.run, workers.Exit{N: p.run.N, Reason: "任务已停止或进入下一阶段"})
	}
	marked, err := markUnavailable(ctx, db, p.run, sig)
	if err != nil {
		return err
	}
	if err := d.markSharedFailure(ctx, p, sig); err != nil {
		if isAPI(err) {
			return d.block(ctx, p.task, "共享池恢复受阻："+err.Error())
		}
		return err
	}
	// 每轮都记结果，包括空回复，防止新一轮无正文时沿用旧结论。
	if err := ledger.Record(ctx, db, p.task, gates.KindResult, actor, p.adapter.LastReply(log.Text)); err != nil {
		return err
	}
	note := route.Reason
	if sig.Evidence != "" {
		note += "（" + sig.Evidence + "）"
	}
	note += marked
	exit := workers.Exit{N: p.run.N, Model: workers.ModelOf(p.run.Worker, head), Outcome: workers.OutcomeOf(sig, route.Do != "fail"), Reason: note}
	if err := recordExit(ctx, db, p.task, p.run, exit); err != nil {
		return err
	}
	apply := func(kind ledger.EventKind, why string) error {
		_, err := ledger.Apply(ctx, db, p.task, ledger.Event{Kind: kind}, actor, why)
		if err != nil && isAPI(err) {
			return nil // 别人先收了尾（conflict）
		}
		return err
	}
	switch route.Do {
	case "gate":
		return apply(ledger.ExitOK, note)
	case "fail":
		return apply(ledger.ExitFail, note)
	case "block":
		return apply(ledger.Block, note)
	}
	if paused, err := d.paused(ctx, t, p.run.Host); err != nil || paused {
		if err != nil {
			return err
		}
		return apply(ledger.Block, note+"；停机中没有重新拉起，恢复后 atrium task run "+p.task)
	}
	o := launchOpts{Tokens: p.run.Tokens, Host: p.run.Host, Risk: p.run.Risk, Secrets: p.run.Secrets}
	switch route.Do {
	case "same", "resume", "restart":
		o.W, err = workers.Resolve(ctx, db, p.run.Worker)
		o.Why = map[string]string{"same": workers.WhySame, "resume": workers.WhyResume, "restart": workers.WhyRestart}[route.Do]
		if route.Do == "resume" {
			o.Session = session
			for _, tr := range pending {
				o.Pending = append(o.Pending, tr.Text)
			}
		}
	case "switch":
		var why string
		o.W, why, err = d.choose(ctx, t, Options{Risk: p.run.Risk, Tokens: p.run.Tokens}, tried)
		o.Why = workers.WhySwitch
		wait := why != ""
		if err == nil && !wait {
			o.Host, wait, err = d.switchHost(ctx, t, o.W.Spec, cmp.Or(p.run.Host, LocalHost))
		}
		if err == nil && wait {
			return d.requeue(ctx, p, tried, note)
		}
	}
	if err == nil {
		err = d.launch(ctx, t, o)
	}
	if err != nil {
		if !isAPI(err) {
			return err
		}
		return apply(ledger.Block, note+"；重新拉起受阻："+err.Error())
	}
	return ledger.Note(ctx, db, p.task, actor, "执行者退出："+note+"；已重新拉起（"+o.Why+"，"+o.W.ID+"）")
}

// requeue 是换人时能换的此刻都接不了（被不可用标记挡着、正忙、机器满）：放回队列等，不转受阻——
// 标记到期或解除、执行者空下来后分派任务循环照常派出；换人次数接着这一轮数，满了仍转受阻。
func (d *dispatcher) requeue(ctx context.Context, p *proc, tried map[string]bool, note string) error {
	available, err := workers.LoadAvailability(ctx, d.env)
	if err != nil {
		return err
	}
	o := retryOpts(&p.run, tried, available.Marked)
	_, err = putRow(ctx, d.env.DB, p.task, o, ledger.Requeue, actor, note+"；能换的执行者此刻都接不了，放回队列等")
	if err != nil && isAPI(err) {
		return nil // 别人先收了尾（conflict）
	}
	return err
}
