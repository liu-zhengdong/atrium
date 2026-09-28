package dispatch

import (
	"context"
	"database/sql"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
	"github.com/liu-zhengdong/atrium/internal/watch"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// StopResult 是 task stop 的结果：Stopping 为真表示已发停止信号，退出后转受阻。
type StopResult struct {
	Task     ledger.Task `json:"task"`
	Stopping bool        `json:"stopping"`
}

// Stop 停下一件任务：排队的撤出队列转受阻；在跑的结束执行者进程树，退出后转受阻交负责人。
// watch 也用它（why 写明原因）。
func Stop(ctx context.Context, env *app.Env, id, why, by string) (StopResult, error) {
	d := get(env)
	t, err := ledger.Get(ctx, env.DB, id)
	if err != nil {
		return StopResult{}, err
	}
	note := "已停下（" + by + "）"
	if why != "" {
		note += "：" + why
	}
	switch {
	case t.Status == ledger.Queued:
		if err := d.block(ctx, id, note); err != nil {
			return StopResult{}, err
		}
		t, err = ledger.Get(ctx, env.DB, id)
		return StopResult{Task: t}, err
	case t.Status == ledger.Running && t.Stage == ledger.StageNone:
		p := d.procOf(id)
		if p == nil {
			// 没有在跑的进程（拉起失败或刚退出）：直接转受阻。
			t, err = ledger.Apply(ctx, env.DB, id, ledger.Event{Kind: ledger.Block}, by, note+"；没有找到在跑的执行者进程")
			return StopResult{Task: t}, err
		}
		p.setStop("block")
		if err := ledger.Note(ctx, env.DB, id, by, note); err != nil {
			return StopResult{}, err
		}
		d.kill(ctx, p)
		return StopResult{Task: t, Stopping: true}, nil
	}
	return StopResult{}, api.Conflict("%s 当前 %s，没有排队或在跑的执行者可停", id, label(t)).WithNext("atrium task show " + id)
}

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
	Via  string `json:"via"` // stdin resume restart next
	Note string `json:"note"`
}

const maxTell = 4000

// Tell 给任务捎话：先记进经历；在跑的按工具送到（即时写标准输入、本轮后续上、停掉带着补充重派），没在跑的下次拉起写进提示词。
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
		return TellResult{}, api.Conflict("%s 已%s，捎话没人收", id, t.Status).WithNext("atrium task add <标题> --parent " + id)
	}
	var tid int64
	err = env.DB.Tx(ctx, func(tx *sql.Tx) error {
		if err := ledger.Record(ctx, tx, id, "tell", by, text); err != nil {
			return err
		}
		return tx.QueryRowContext(ctx, `SELECT last_insert_rowid()`).Scan(&tid)
	})
	if err != nil {
		return TellResult{}, err
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
		r.Via, r.Note = "resume", "本轮已收尾，退出后带着补充续上会话"
	case workers.TellResume:
		r.Via, r.Note = "resume", "本轮结束后带着补充续上会话"
	default:
		p.setStop("restart")
		d.kill(ctx, p)
		r.Via, r.Note = "restart", "已停掉执行者，带着补充重派"
	}
	return r, nil
}

// LogChunk 是 task log 的一段：人读的行与下一次从哪读。
type LogChunk struct {
	Task    string `json:"task"`
	Run     int    `json:"run"`
	Worker  string `json:"worker"`
	Text    string `json:"text"`
	Offset  int64  `json:"offset"`
	Running bool   `json:"running"`
}

const logChunk = 256 * 1024

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
		text, next, err := readFrom(run.Log, offset)
		if err != nil {
			return c, err
		}
		if text != "" || !c.Running || time.Now().After(deadline) {
			c.Text, c.Offset = Readable(text), next
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

// readFrom 读到最后一个完整行；offset < 0 表示读末尾一段（从下一行开头起）。
func readFrom(path string, offset int64) (string, int64, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return "", max(offset, 0), nil
	}
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", 0, err
	}
	tail := offset < 0
	if tail {
		offset = max(st.Size()-64*1024, 0)
	}
	if offset > st.Size() {
		offset = st.Size()
	}
	buf := make([]byte, min(st.Size()-offset, logChunk))
	if _, err := f.ReadAt(buf, offset); err != nil && err != io.EOF {
		return "", 0, err
	}
	s := string(buf)
	if tail && offset > 0 {
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s, offset = s[i+1:], offset+int64(i+1)
		}
	}
	end := strings.LastIndexByte(s, '\n')
	if end < 0 {
		return "", offset, nil
	}
	return s[:end+1], offset + int64(end+1), nil
}

// Readable 把日志一段变成人读的行（空行与不值得看的事件去掉）。
func Readable(text string) string {
	var out []string
	for _, l := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		if r := workers.Readable(l); strings.TrimSpace(r) != "" {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return ""
	}
	return strings.Join(out, "\n") + "\n"
}

// hook 接上 watch 的重新入队与周期任务的派活（服务进程里，Routes 装配时调）。
func hook(env *app.Env) {
	watch.Use(watch.Hooks{Requeue: func(ctx context.Context, task string, why watch.Why) error {
		return Requeue(ctx, env, task, why)
	}})
	agenda.Enqueue = func(ctx context.Context, env *app.Env, task, by string) error {
		_, err := Enqueue(ctx, env, task, Options{}, by)
		return err
	}
}

// Requeue 给 watch：卡住或读到信号转失败后重新入队。额度用尽、思考耗尽换人（避开原执行者），其余同一执行者再来。
func Requeue(ctx context.Context, env *app.Env, id string, why watch.Why) error {
	run, err := workers.LastRun(ctx, env.DB, id)
	if err != nil {
		return err
	}
	o := Options{Risk: "low"}
	if run != nil {
		o.Risk, o.Secrets = run.Risk, run.Secrets
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
