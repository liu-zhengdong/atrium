package dispatch

import (
	"cmp"
	"context"
	"database/sql"
	"os"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
	"github.com/liu-zhengdong/atrium/internal/watch"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func label(t ledger.Task) string {
	if t.Stage == ledger.StageNone {
		return string(t.Status)
	}
	return string(t.Status) + "/" + string(t.Stage)
}

// TellResult 是 task tell 的结果：Via 说明怎么送到。
type TellResult struct {
	Task string `json:"task"`
	ID   int64  `json:"id"`
	Via  string `json:"via"` // stdin resume restart next leader
	Note string `json:"note"`
}

const maxTell = 4000

// Tell 给任务补充说明，是补充说明与改说明（ledger.Tell）唯一的送达入口：先记进经历；交给负责人拆着的同一事务里发给它；
// 挂着在问用户的话的，这条是回话（负责人自己说的是撤回）：清掉那句话、发给处理它的负责人（ledger.RecordTell）；
// 在跑的按工具送到（即时写标准输入、本轮后继续、停掉带着补充重派），没在跑的下次拉起写进提示词。
func Tell(ctx context.Context, env *app.Env, id, text, by string) (TellResult, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return TellResult{}, api.Usage("<文字>: 不能为空")
	}
	if len([]rune(text)) > maxTell {
		return TellResult{}, api.Usage("<文字>: 最多 %d 字", maxTell)
	}
	d := get(env)
	var t ledger.Task
	var tid int64
	var leader string
	err := env.DB.Tx(ctx, func(tx *sql.Tx) (err error) {
		t, err = ledger.Get(ctx, tx, id)
		if err != nil {
			return err
		}
		if t.Status.Finished() {
			return api.Conflict("%s 已%s，任务已结束，无法再补充说明", id, t.Status).WithNext("atrium task add <标题> --parent " + id)
		}
		tid, leader, err = ledger.RecordTell(ctx, tx, t, text, by)
		return err
	})
	if err != nil {
		return TellResult{}, err
	}
	switch {
	case t.Ask != "" && leader != "":
		return TellResult{Task: id, ID: tid, Via: "leader", Note: "已清掉在问用户的话，回话发给负责人 " + leader + "（要处理），它醒来时读到"}, nil
	case t.Ask != "":
		return TellResult{Task: id, ID: tid, Via: "next", Note: "已清掉在问用户的话（撤回），下次拉起时写进提示词"}, nil
	case leader != "":
		return TellResult{Task: id, ID: tid, Via: "leader", Note: "已发给拆它的负责人 " + leader + "（要处理），它醒来时读到"}, nil
	}
	r := TellResult{Task: id, ID: tid, Via: "next", Note: "下次拉起时写进提示词"}
	p := d.procOf(id)
	if t.Status != ledger.Running || t.Stage != ledger.StageNone || p == nil {
		return r, nil
	}
	switch p.adapter.Tell {
	case workers.TellResume:
		r.Via, r.Note = "resume", "本轮结束后带着补充继续会话"
	default:
		p.setStop("restart")
		d.kill(ctx, p)
		r.Via, r.Note = "restart", "已停掉执行者，带着补充重派"
	}
	return r, nil
}

// LogChunk 是 task log 的一段：日志原文（到最后一个完整行）与下一次从哪读。
type LogChunk struct {
	From     int64         `json:"from"`
	Size     int64         `json:"size"`
	Complete bool          `json:"complete"`
	Usage    workers.Usage `json:"usage"`
	Task     string        `json:"task"`
	Run      int           `json:"run"`
	Worker   string        `json:"worker"`
	Text     string        `json:"text"`
	Offset   int64         `json:"offset"`
	Running  bool          `json:"running"`
}

// hook 接上 watch 的重新入队、定时任务与审阅轮的分派任务、改说明的补充说明（服务进程里，Routes 装配时调）。
func hook(env *app.Env) {
	watch.Use(watch.Hooks{Requeue: func(ctx context.Context, task string, why watch.Why) error {
		return Requeue(ctx, env, task, why)
	}})
	agenda.Enqueue = func(ctx context.Context, env *app.Env, task, by string) error {
		_, err := Enqueue(ctx, env, task, Options{}, by)
		return err
	}
	gates.Review = func(ctx context.Context, task, who string) error {
		return Review(ctx, env, task, who)
	}
	ledger.Tell = func(ctx context.Context, task, text, by string) error {
		_, err := Tell(ctx, env, task, text, by)
		return err
	}
}

// Review 在原任务上拉起一轮审阅（gates 经装配的 gates.Review 调用）：作者刚退出，审阅者就跑在同一台机器上。
// who 空：按 worker_require 挑（不同工具、不同模型、trust 够、不是作者）；能审的都忙时静默返回，gates.Sweep 下轮再试。
// who 非空：交回这位审阅者重审（读不出结论的交回计次在 gates，不计作者的重试预算）。
// 不改任务的执行者与机器登记：打回后 dispatch 沿用作者的登记重派（record 里审阅轮分支）。
func Review(ctx context.Context, env *app.Env, id, who string) error {
	db := env.DB
	t, err := ledger.Get(ctx, db, id)
	if err != nil {
		return err
	}
	if t.Status != ledger.Running || t.Stage != ledger.StageReview {
		return api.Conflict("%s 不在审阅阶段（当前 %s/%s），不拉起审阅轮", id, t.Status, t.Stage)
	}
	last, err := lastAuthorRun(ctx, db, id)
	if err != nil {
		return err
	}
	if last == nil {
		return api.Conflict("%s 还没拉起过执行者，无从审阅", id)
	}
	d := get(env)
	var w workers.Resolved
	if who != "" {
		if w, err = workers.Resolve(ctx, db, who); err != nil {
			return err
		}
		req, err := requirement(ctx, db, id)
		if err != nil {
			return err
		}
		if who == last.Worker {
			return api.Conflict("作者不能审阅自己的任务 %s", id)
		}
		if why := reviewRefusal(req, w.ID, w.Spec.Tool, w.Spec.Model, w.Rules.EffectiveTrust()); why != "" {
			return api.Conflict("%s 不能重审 %s：%s", who, id, why)
		}
		busy, err := busyTools(ctx, db)
		if err != nil {
			return err
		}
		if w.Adapter.Exclusive && busy[w.Spec.Tool] {
			return nil
		}
	} else {
		var wait string
		if w, wait, err = d.chooseReview(ctx, t, last); err != nil {
			return err
		}
		if wait != "" {
			return nil // 能审的都忙：留到下一轮 Sweep 再挑
		}
	}
	// 机器容量：作者刚退出，同一台一般有空位；满了留在下一轮。
	need, err := hostNeed(ctx, db, w.Spec, t)
	if err != nil {
		return err
	}
	need.Task = id // 同一任务的审阅轮接替作者，占用原来的机器容量
	choice, err := pickHost(ctx, env, need, last.Host)
	if err != nil {
		return err
	}
	switch choice.Kind {
	case "queue":
		return nil
	case "refuse":
		return api.Conflict("%s 的审阅轮上不了 %s：%s", id, last.Host, choice.Reason)
	}
	if choice.Host != last.Host {
		return api.Conflict("%s 的审阅轮换不了机器（作者工作目录在 %s）：%s", id, last.Host, choice.Reason)
	}
	o := launchOpts{Tokens: last.Tokens, W: w, Host: choice.Host, Risk: cmp.Or(last.Risk, "low"),
		Why: workers.WhyReview, Review: true, Dir: last.Dir}
	return d.launch(ctx, t, o)
}

// chooseReview 挑审阅执行者：档案能接 + 额度富余 + 不正忙 + 满足 worker_require（不同工具、不同模型、trust 够）+ 不是作者。
// 要求只对审阅轮生效（view 的 review 参数），作者自己的重试不走这里。
func (d *dispatcher) chooseReview(ctx context.Context, t ledger.Task, last *workers.Run) (workers.Resolved, string, error) {
	exclude := map[string]bool{}
	if last.Worker != "" {
		exclude[last.Worker] = true // 作者不会成为自己的审阅者
	}
	return d.choose(ctx, t, Options{Risk: cmp.Or(last.Risk, "low"), Tokens: last.Tokens, Host: last.Host}, exclude, true)
}

// Requeue 给 watch：失败后重新入队；额度先标不可用，额度/思考沿用换人上限。
// 额度失败按账号与机器范围避开，其他失败避开已试过的组合；被停的任务不再派。
func Requeue(ctx context.Context, env *app.Env, id string, why watch.Why) error {
	t, err := ledger.Get(ctx, env.DB, id)
	if err != nil {
		return err
	}
	if t.Status != ledger.Failed {
		return nil // 被停、取消或已经进入关卡的任务不能被巡检重新派出。
	}
	run, err := workers.LastRun(ctx, env.DB, id)
	if err != nil {
		return err
	}
	if run != nil {
		outcome, sig := workers.OutFail, workers.Signal{}
		switch {
		case why.Signal == watch.SigQuota:
			outcome = workers.OutQuota
			log, err := workers.Tail(run.Log, workers.TailBytes)
			if err != nil && !os.IsNotExist(err) {
				return err
			}
			sig = workers.Classify(1, run.Worker, log, time.Now())
		case why.Role == watch.RoleWorkerStart:
			// 启动后没进展（watch 判）：与零步骤退出、静默空转同类（都没干起来），标 nostart 避开一段时间，到期自动再试。
			outcome = workers.OutSetup
			sig = workers.Signal{Kind: workers.SignalNoStart, Reason: "启动后没进展", Evidence: why.Reason}
		}
		head, err := readHead(run.Log, 64*1024)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		exit := workers.Exit{N: run.N, Model: workers.ModelOf(run.Worker, head), Outcome: outcome, Reason: why.Reason}
		if err := recordExit(ctx, env.DB, id, *run, exit); err != nil {
			return err
		}
		marked, err := markUnavailable(ctx, env.DB, *run, sig)
		if err != nil {
			return err
		}
		if marked != "" {
			if err := ledger.Note(ctx, env.DB, id, actor, strings.TrimPrefix(marked, "；")); err != nil {
				return err
			}
		}
	}
	runs, err := workers.Runs(ctx, env.DB, id, 50)
	if err != nil {
		return err
	}
	_, switches, tried := tries(runs)
	if why.Worker != "" {
		tried[why.Worker] = true
	}
	available, err := workers.LoadAvailability(ctx, env)
	if err != nil {
		return err
	}
	o := retryOpts(run, tried, available.Marked)
	if _, err := Enqueue(ctx, env, id, o, actor); err != nil {
		return err
	}
	if switches >= maxSwitches {
		return get(env).block(ctx, id, why.Reason+"；已换过 "+itoa(switches)+" 次执行者")
	}
	return nil
}
