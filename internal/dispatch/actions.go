package dispatch

import (
	"context"
	"database/sql"
	"os"
	"strconv"
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
	t, err := ledger.Get(ctx, env.DB, id)
	if err != nil {
		return TellResult{}, err
	}
	if t.Status.Finished() {
		return TellResult{}, api.Conflict("%s 已%s，任务已结束，无法再补充说明", id, t.Status).WithNext("atrium task add <标题> --parent " + id)
	}
	var tid int64
	var leader string
	err = env.DB.Tx(ctx, func(tx *sql.Tx) (err error) {
		tid, leader, err = ledger.RecordTell(ctx, tx, t, text, by)
		return err
	})
	if err != nil {
		return TellResult{}, err
	}
	if leader != "" {
		return TellResult{Task: id, ID: tid, Via: "leader", Note: "已发给拆它的负责人 " + leader + "（要处理），它醒来时读到"}, nil
	}
	r := TellResult{Task: id, ID: tid, Via: "next", Note: "下次拉起时写进提示词"}
	p := d.procOf(id)
	if t.Status != ledger.Running || t.Stage != ledger.StageNone || p == nil {
		return r, nil
	}
	switch p.adapter.Tell {
	case workers.TellStdin:
		if p.send(text, "tell-"+strconv.FormatInt(tid, 10)) {
			r.Via, r.Note = "stdin", "已写进执行者的标准输入，下一个工具调用边界读入"
			return r, nil
		}
		r.Via, r.Note = "resume", "本轮已收尾，退出后带着补充继续会话"
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
	Usage   workers.Usage `json:"usage"`
	Task    string        `json:"task"`
	Run     int           `json:"run"`
	Worker  string        `json:"worker"`
	Text    string        `json:"text"`
	Offset  int64         `json:"offset"`
	Running bool          `json:"running"`
}

// ReadLog 读最近一次拉起的日志：offset < 0 读末尾一段；否则从 offset 读，wait 时没有新内容就等（有新内容、执行者退出或超时）。
func ReadLog(ctx context.Context, env *app.Env, id string, offset int64, wait time.Duration) (LogChunk, error) {
	d := get(env)
	if _, err := ledger.Get(ctx, env.DB, id); err != nil {
		return LogChunk{}, err
	}
	run, err := workers.LastRun(ctx, env.DB, id)
	if err != nil {
		return LogChunk{}, err
	}
	if run == nil {
		return LogChunk{}, api.NotFound("%s 还没拉起过执行者", id).WithNext("atrium task run " + id)
	}
	c := LogChunk{Task: id, Run: run.N, Worker: run.Worker}
	deadline := time.Now().Add(wait)
	for {
		p := d.procOf(id)
		c.Running = p != nil && p.run.N == run.N
		if !c.Running {
			c.Usage, err = workers.ExitUsage(ctx, env.DB, id, run.N)
			if err != nil {
				return c, err
			}
		}
		text, next, err := workers.ReadLog(run.Log, offset)
		if err != nil {
			return c, err
		}
		if text != "" || !c.Running || time.Now().After(deadline) {
			c.Text, c.Offset = text, next
			return c, nil
		}
		select {
		case <-ctx.Done():
			return c, ctx.Err()
		case <-p.done:
		case <-time.After(300 * time.Millisecond):
		}
	}
}

// hook 接上 watch 的重新入队、定时任务与审阅任务的分派任务、改说明的补充说明（服务进程里，Routes 装配时调）。
func hook(env *app.Env) {
	watch.Use(watch.Hooks{Requeue: func(ctx context.Context, task string, why watch.Why) error {
		return Requeue(ctx, env, task, why)
	}})
	agenda.Enqueue = func(ctx context.Context, env *app.Env, task, by string) error {
		_, err := Enqueue(ctx, env, task, Options{}, by)
		return err
	}
	gates.Enqueue = func(ctx context.Context, task, by string) error {
		_, err := Enqueue(ctx, env, task, Options{}, by)
		return err
	}
	ledger.Tell = func(ctx context.Context, task, text, by string) error {
		_, err := Tell(ctx, env, task, text, by)
		return err
	}
}

// Requeue 给 watch：卡住或读到信号转失败后重新入队。额度用尽先标「工具+模型@机器」不可用；额度用尽、思考耗尽换人（避开原执行者），其余同一执行者再来。
func Requeue(ctx context.Context, env *app.Env, id string, why watch.Why) error {
	run, err := workers.LastRun(ctx, env.DB, id)
	if err != nil {
		return err
	}
	o := Options{Risk: "low"}
	if run != nil {
		o.Risk, o.Secrets = run.Risk, run.Secrets
		outcome := workers.OutFail
		if why.Signal == watch.SigQuota {
			outcome = workers.OutQuota
		}
		head, err := readHead(run.Log, 64*1024)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		exit := workers.Exit{N: run.N, Model: workers.ModelOf(run.Worker, head), Outcome: outcome, Reason: why.Reason}
		if err := recordExit(ctx, env.DB, id, *run, exit); err != nil {
			return err
		}
	}
	if why.Signal == watch.SigQuota && run != nil {
		tail, err := workers.Tail(run.Log, workers.TailBytes)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		marked, err := markUnavailable(ctx, env.DB, *run, workers.Classify(1, run.Worker, tail, time.Now()))
		if err != nil {
			return err
		}
		if marked != "" {
			if err := ledger.Note(ctx, env.DB, id, actor, strings.TrimPrefix(marked, "；")); err != nil {
				return err
			}
		}
	}
	switch why.Signal {
	case watch.SigQuota, watch.SigThinking:
		if why.Worker != "" {
			o.Avoid = []string{why.Worker}
		}
	default:
		o.Worker = why.Worker
	}
	_, err = Enqueue(ctx, env, id, o, actor)
	return err
}
