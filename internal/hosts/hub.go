package hosts

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// Assignment 是派到远程机器的一次运行（dispatch 组装，hosts 补轮号）。
// 提示词由服务写好；代理在自己机器上克隆仓库、建工作树（Request.Dir 由代理填）、按同一份适配器拉起。
type Assignment struct {
	Task    string          `json:"task"`
	Run     int             `json:"run"`
	Tool    string          `json:"tool"` // workers 适配器名
	Request workers.Request `json:"request"`
	Repo    string          `json:"repo,omitempty"` // 克隆地址；空为不带仓库（在任务目录的 work 下跑）
	Branch  string          `json:"branch,omitempty"`
	Base    string          `json:"base,omitempty"`
	// Env 是任务声明的凭据：名称 → 值。只在这条指令里（服务与代理都只放内存），代理按名称合进执行者环境。
	Env map[string]string `json:"env,omitempty"`
	// Token 是这次拉起的执行者令牌：代理连同自己连服务的地址一起放进执行者环境（ATRIUM_WORKER_TOKEN、ATRIUM_SERVER）。只放内存。
	Token string `json:"token,omitempty"`
	// Log 是服务这台上的日志文件：代理传来的日志按字节偏移追加到这里。不发给代理。
	Log string `json:"-"`
}

// Query 是服务问代理的只读查询（交付检查查远程工作树的事实）：在 Dir 里跑一条只读 git，或读 Dir 根下的一个文件。
// 代理按 QueryRefusal 核对。
type Query struct {
	Dir  string   `json:"dir"`
	Git  []string `json:"git,omitempty"`
	File string   `json:"file,omitempty"`
}

// Command 是服务下发给代理的指令：launch 拉起、stop 结束、query 查询。
type Command struct {
	ID      string          `json:"id"`
	Kind    string          `json:"kind"`
	Launch  *Assignment     `json:"launch,omitempty"`
	Stop    *RunRef         `json:"stop,omitempty"`
	Query   *Query          `json:"query,omitempty"`
	Reclaim *ReclaimRequest `json:"reclaim,omitempty"`
}

// Ack 是代理对指令的回执。拉起回 PID 与工作目录；查询回输出（读文件时 Missing 表示没有这个文件）。
type Ack struct {
	ID      string `json:"id"`
	OK      bool   `json:"ok"`
	PID     int    `json:"pid,omitempty"`
	Dir     string `json:"dir,omitempty"`
	Output  string `json:"output,omitempty"`
	Missing bool   `json:"missing,omitempty"`
	Error   string `json:"error,omitempty"`
}

// hub 是服务进程里与代理往来的内存状态：每台待领的指令、在等的长轮询、在等的回执、运行变化的通知。
// 服务重启后清空：代理重连对账，dispatch 重新 WaitExit。
type hub struct {
	mu      sync.Mutex
	queue   map[string][]Command
	wake    map[string]chan struct{}
	polling map[string]int
	acks    map[string]chan Ack
	changed chan struct{}
	seq     int
}

var theHub = newHub()

func newHub() *hub {
	return &hub{queue: map[string][]Command{}, wake: map[string]chan struct{}{}, polling: map[string]int{},
		acks: map[string]chan Ack{}, changed: make(chan struct{})}
}

func (h *hub) wakeLocked(host string) chan struct{} {
	c, ok := h.wake[host]
	if !ok {
		c = make(chan struct{})
		h.wake[host] = c
	}
	return c
}

func (h *hub) push(host string, c Command) (string, chan Ack) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq++
	c.ID = fmt.Sprintf("%s-%d-%d", host, time.Now().UnixMilli(), h.seq)
	ack := make(chan Ack, 1)
	h.acks[c.ID] = ack
	h.queue[host] = append(h.queue[host], c)
	close(h.wakeLocked(host))
	delete(h.wake, host)
	return c.ID, ack
}

// withdraw 撤回还没被领走的指令；已领走返回 false。
func (h *hub) withdraw(host, id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.acks, id)
	q := h.queue[host]
	for i, c := range q {
		if c.ID == id {
			h.queue[host] = append(q[:i:i], q[i+1:]...)
			return true
		}
	}
	return false
}

// take 长轮询：有指令立即拿走，没有就等到有或超时。
func (h *hub) take(ctx context.Context, host string, wait time.Duration) []Command {
	h.mu.Lock()
	h.polling[host]++
	defer func() { h.mu.Lock(); h.polling[host]--; h.mu.Unlock() }()
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		if q := h.queue[host]; len(q) > 0 {
			delete(h.queue, host)
			h.mu.Unlock()
			return q
		}
		w := h.wakeLocked(host)
		h.mu.Unlock()
		select {
		case <-w:
		case <-timer.C:
			return nil
		case <-ctx.Done():
			return nil
		}
		h.mu.Lock()
	}
}

func (h *hub) forget(id string) {
	h.mu.Lock()
	delete(h.acks, id)
	h.mu.Unlock()
}

func (h *hub) ack(a Ack) bool {
	h.mu.Lock()
	c, ok := h.acks[a.ID]
	delete(h.acks, a.ID)
	h.mu.Unlock()
	if ok {
		c <- a
	}
	return ok
}

func (h *hub) isPolling(host string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.polling[host] > 0
}

func (h *hub) pending(host, id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.pendingLocked(host, id)
}

func (h *hub) pendingLocked(host, id string) bool {
	for _, c := range h.queue[host] {
		if c.ID == id {
			return true
		}
	}
	return false
}

// dropQueued 撤回还在队列里的指令。已经领走则不动，返回 false。
func (h *hub) dropQueued(host, id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.pendingLocked(host, id) {
		return false
	}
	delete(h.acks, id)
	q := h.queue[host]
	for i, c := range q {
		if c.ID == id {
			h.queue[host] = append(q[:i:i], q[i+1:]...)
			return true
		}
	}
	return false
}

// notify 告诉在等退出的人：某次运行有变化。
func (h *hub) notify() {
	h.mu.Lock()
	close(h.changed)
	h.changed = make(chan struct{})
	h.mu.Unlock()
}

func (h *hub) changes() chan struct{} {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.changed
}

// ---- 给 dispatch 的接口 ----

// ackWait 是等代理领走并回执拉起的上限。
var ackWait = 60 * time.Second

// Launch 把一次运行派到远程机器：记下这一轮、下发指令、等代理拉起后回执。返回轮号、pid 与那台上的工作目录。
// 机器没在领指令、指令还没领走时返回 app.NotNow，调用方下一轮再试，不把任务转受阻。
// 指令已经领走却没回执仍是失败（这一轮可能已经拉起了进程）。之后日志按字节偏移追加到 a.Log，退出用 WaitExit 等。
func Launch(ctx context.Context, env *app.Env, host string, a Assignment) (run, pid int, dir string, err error) {
	h, err := Get(ctx, env.DB, host)
	if err != nil {
		return 0, 0, "", err
	}
	if h.Kind != "remote" {
		return 0, 0, "", api.Usage("%s 是本机，本机的执行者由 dispatch 直接拉起", host)
	}
	if !h.Joined {
		return 0, 0, "", api.Conflict("%s 还没接入", host)
	}
	if !validLogFile(a.Log) {
		return 0, 0, "", api.Usage("Assignment.Log 不能为空")
	}
	if err := os.MkdirAll(filepath.Dir(a.Log), 0o700); err != nil {
		return 0, 0, "", err
	}
	if err := waitPolling(ctx, host); err != nil {
		return 0, 0, "", err
	}
	err = env.DB.Tx(ctx, func(tx *sql.Tx) error {
		prev, err := getRun(ctx, tx, a.Task)
		switch {
		case store.IsNotFound(err):
		case err != nil:
			return err
		case !prev.Exited:
			return api.Conflict("%s 在 %s 上的第 %d 轮还没退出", a.Task, prev.Host, prev.Run)
		}
		a.Run = prev.Run + 1
		_, err = tx.ExecContext(ctx, `INSERT INTO host_runs (task, host, run, log_file, started_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (task) DO UPDATE SET host = excluded.host, run = excluded.run, pid = 0, log_file = excluded.log_file,
			log_offset = 0, exit_code = NULL, exit_lost = 0, exited_at = NULL, started_at = excluded.started_at`,
			a.Task, host, a.Run, a.Log, store.Now())
		return err
	})
	if err != nil {
		return 0, 0, "", err
	}
	// 日志文件接着写（多轮追加）；各轮的续传位置记在 host_runs。
	f, err := os.OpenFile(a.Log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return 0, 0, "", err
	}
	f.Close()
	id, ackc := theHub.push(host, Command{Kind: "launch", Launch: &a})
	fail := func(e error) (int, int, string, error) {
		// 没拉起：这一轮按退出不明收尾，免得 WaitExit 永远等。
		finishRun(context.WithoutCancel(ctx), env.DB, RunRef{a.Task, a.Run}, Exit{Lost: true})
		theHub.notify()
		return 0, 0, "", e
	}
	ack, err := waitAck(ctx, host, id, ackc, ackWait, "launch")
	if err != nil {
		// 取消仍是 ctx 的错误（调用方用 errors.Is 识别）。没领走的超时是 NotNow，不包成冲突。
		if !app.IsNotNow(err) && ctx.Err() == nil {
			err = api.Conflict("%s", err.Error())
		}
		return fail(err)
	}
	if !ack.OK {
		return fail(api.Conflict("%s 拉起失败：%s", host, ack.Error))
	}
	if _, err := env.DB.ExecContext(ctx, `UPDATE host_runs SET pid = ? WHERE task = ? AND run = ?`, ack.PID, a.Task, a.Run); err != nil {
		return 0, 0, "", err
	}
	return a.Run, ack.PID, ack.Dir, nil
}

// queryWait 是等代理答一条查询的上限（含领走；fetch 要走网络）。
var queryWait = 2 * time.Minute

// Ask 问远程机器一条只读查询（交付检查查远程工作树的事实）：下发、等回执。
// 机器没在领指令时返回 app.NotNow，调用方下一轮再试。代理拒绝或跑失败返回错误。
func Ask(ctx context.Context, host string, q Query) (Ack, error) {
	ack, err := call(ctx, host, Command{Kind: "query", Query: &q}, queryWait)
	if err != nil {
		return Ack{}, err
	}
	if !ack.OK {
		return ack, fmt.Errorf("%s 上查询失败：%s", host, ack.Error)
	}
	return ack, nil
}

// Stop 让代理结束这个任务当前这一轮（整棵进程树）；退出照常经 WaitExit 报回。
func Stop(ctx context.Context, env *app.Env, task string) error {
	r, err := getRun(ctx, env.DB, task)
	if store.IsNotFound(err) {
		return api.NotFound("%s 没有远程运行", task)
	}
	if err != nil {
		return err
	}
	if r.Exited {
		return nil
	}
	id, _ := theHub.push(r.Host, Command{Kind: "stop", Stop: &r.RunRef})
	theHub.forget(id) // 不等回执：结束后的退出照常报回
	return nil
}

// WaitExit 等某次远程运行退出（服务重启后照样能等：状态在 host_runs）。
func WaitExit(ctx context.Context, env *app.Env, task string, run int) (Exit, error) {
	for {
		ch := theHub.changes()
		r, err := getRun(ctx, env.DB, task)
		if err != nil {
			return Exit{}, err
		}
		if r.Run != run {
			return Exit{Lost: true}, nil // 已经换了一轮
		}
		if r.Exited {
			return r.Exit, nil
		}
		select {
		case <-ch:
		case <-ctx.Done():
			return Exit{}, ctx.Err()
		}
	}
}

// Pick 给 dispatch 挑机器：pinned 是 --host 指定的（只看那台）；暂停的机器不选（问 pause 的机器范围）；
// 这件活的「工具+模型」在那台上标了不可用的不选。
func Pick(ctx context.Context, env *app.Env, need Need, pinned string) (Choice, error) {
	list, err := usableHosts(ctx, env)
	if err != nil {
		return Choice{}, err
	}
	busy, err := running(ctx, env.DB)
	if err != nil {
		return Choice{}, err
	}
	pauses, err := env.Pause.List(ctx)
	if err != nil {
		return Choice{}, err
	}
	var active []string
	for _, p := range pauses {
		active = append(active, p.Scope)
	}
	now := store.Now()
	available, err := workers.LoadAvailability(ctx, env)
	if err != nil {
		return Choice{}, err
	}
	w := workers.Resolved{Spec: workers.Spec{Tool: need.Tool, Model: need.Model}}
	if need.Tool != "" {
		_, builtin := workers.Builtin(need.Tool)
		profile, err := workers.GetProfile(ctx, env.DB, "harness/"+need.Tool)
		if err != nil {
			return Choice{}, err
		}
		// 代理的通用命令也可直接挑机器，未登记档案时账号保持未知。
		if builtin || profile != nil {
			w, err = workers.Resolve(ctx, env.DB, w.Spec.String())
			if err != nil {
				return Choice{}, err
			}
		}
	}
	var cands []Candidate
	for _, h := range list {
		c := candidate(h, busy[h.ID], pause.Paused(active, pause.Scope{Host: h.ID}), theHub.isPolling(h.ID), now)
		_, c.Unavailable = available.CheckResolved(w, h.ID)
		cands = append(cands, c)
	}
	return Choose(cands, need, pinned), nil
}

func candidate(h Host, running int, paused, polling bool, now int64) Candidate {
	c := Candidate{ID: h.ID, Kind: h.Kind, Paused: paused, Repos: h.Repos, Running: running, Max: h.MaxRunning,
		Conn: Connection(h.Kind, h.Joined, h.JoinExpires, h.LastSeen, polling, now)}
	if h.Info != nil {
		if c.Max == 0 {
			c.Max = h.Info.MaxWorkers
		}
		c.CLIs = h.Info.CLIs
	}
	if h.Load != nil {
		c.Busy = h.Load.Busy
	}
	return c
}
