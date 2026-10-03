// Package dispatch 是分派任务：一个分派任务队列（状态 queued 的任务，按优先级、入队先后取）、挑执行者（档案能接 + 额度富余 +
// 不正忙）、挑机器（本机优先、空位最多），在任务目录的 git worktree 里拉起执行者，退出后按信号重试、换人、继续或进入交付检查。
//
// 命令：task run、task tell（POST /api/tasks/{id}/tell）、task log；停下是 ledger 的 task stop（转受阻，分派任务循环结束它的执行者）。
// 状态只经 ledger.Apply：入队 Enqueue、拉起 Start、退出 ExitOK（进入交付检查，gates 接手）或 ExitFail、停下 Block。
// 拉起记录以任务经历 kind "launch"（workers.Run）存，gates、watch 读它。每次自主动作前问 Pause。
package dispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/watch"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// Module 是本包接入点。
func Module() app.Module {
	hosts.AdapterFor = adapterFor // 远程代理（atrium agent，同一个二进制）按工具名取适配器
	return app.Module{Name: "dispatch", Commands: Commands, Routes: Routes, Run: Run}
}

const actor = "runtime"

// dispatcher 是服务进程里分派任务的内存状态：本机在跑的执行者进程。
type dispatcher struct {
	env             *app.Env
	mu              sync.Mutex
	procs           map[string]*proc
	kick            chan struct{}
	fatal           chan error
	wg              sync.WaitGroup
	reclaimAfter    int64 // 遗留登记扫描游标，单件跳过也推进
	reclaimDeferred bool  // 有执行者未退出或代理离线，后续继续扫描
	// retired：本实例的分派任务循环已退出（服务停下或平滑重启）。之后看到的退出不收尾，交给新服务继续跟进时按日志收。
	retired atomic.Bool
}

var (
	curMu sync.Mutex
	cur   *dispatcher
)

func get(env *app.Env) *dispatcher {
	curMu.Lock()
	defer curMu.Unlock()
	if cur == nil || cur.env != env {
		cur = &dispatcher{env: env, procs: map[string]*proc{}, kick: make(chan struct{}, 1), fatal: make(chan error, 1)}
	}
	return cur
}

func (d *dispatcher) wake() {
	select {
	case d.kick <- struct{}{}:
	default:
	}
}

func (d *dispatcher) procOf(task string) *proc {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.procs[task]
}

// pump 按队列顺序派一轮，所有按件动作经账本统一隔离错误。
func (d *dispatcher) pump(ctx context.Context) error {
	items, err := queued(ctx, d.env.DB)
	if err != nil {
		return err
	}
	return ledger.EachTask(ctx, d.env.DB, "dispatch.pump", items, func(it item) string { return it.Task.ID }, func(it item) error {
		if it.Err != nil {
			return it.Err
		}
		if err := it.Opts.check(); err != nil {
			return err
		}
		deps, err := ledger.Deps(ctx, d.env.DB, it.Task.ID)
		if err != nil {
			return err
		}
		waiting, broken := ledger.DepGate(deps)
		if len(broken) > 0 {
			return d.block(ctx, it.Task.ID, "依赖的 "+ledger.BrokenText(broken)+"，不再自动派")
		}
		if len(waiting) > 0 {
			return nil
		}
		return d.try(ctx, it)
	})
}

func (d *dispatcher) block(ctx context.Context, id, why string) error {
	if err := dropRow(ctx, d.env.DB, id); err != nil {
		return err
	}
	_, err := ledger.Apply(ctx, d.env.DB, id, ledger.Event{Kind: ledger.Block}, actor, why)
	return err
}

// orgScope 是任务的暂停范围（部门链）。
func (d *dispatcher) orgScope(ctx context.Context, t ledger.Task) ([]string, error) {
	if t.Org == "" {
		return nil, nil
	}
	return org.Ancestors(ctx, d.env.DB, t.Org)
}

func (d *dispatcher) paused(ctx context.Context, t ledger.Task, host string) (bool, error) {
	orgs, err := d.orgScope(ctx, t)
	if err != nil {
		return false, err
	}
	return d.env.Pause.Paused(ctx, pause.Scope{Orgs: orgs, Host: host})
}

// try 派一件：停机就跳过；挑执行者（正忙就等）、挑机器（满了就等）；拉起。
func (d *dispatcher) try(ctx context.Context, it item) error {
	t := it.Task
	if p, err := d.paused(ctx, t, ""); err != nil || p {
		return err
	}
	w, wait, err := d.choose(ctx, t, it.Opts, nil)
	if err != nil || wait {
		if err != nil && isAPI(err) {
			return d.block(ctx, t.ID, err.Error())
		}
		return err
	}
	need, err := hostNeed(ctx, d.env.DB, w.Spec, t)
	if err != nil {
		return err
	}
	choice, err := pickHost(ctx, d.env, need, it.Opts.Host)
	if err != nil {
		return err
	}
	switch choice.Kind {
	case "queue":
		return nil
	case "refuse":
		return d.block(ctx, t.ID, "没有机器能接："+choice.Reason)
	}
	if p, err := d.paused(ctx, t, choice.Host); err != nil || p {
		return err
	}
	o := launchOpts{W: w, Host: choice.Host, Risk: it.Opts.Risk, Secrets: it.Opts.Secrets, Why: workers.WhyFirst}
	if len(it.Opts.Avoid) > 0 {
		o.Why = workers.WhySwitch
	}
	if !it.Row { // 没有队列行的 queued 是交回的
		stage, note, ok, err := lastBounce(ctx, d.env.DB, t.ID)
		if err != nil {
			return err
		}
		if ok {
			o.Why, o.Cause = workers.WhyBounce, BounceCause(stage, note)
		}
	}
	return d.launch(ctx, t, o)
}

// BounceCause 判交回的原因类别（纯函数）：交回前所在的交付阶段加原因正文的开头（gates、merge 写的）。
func BounceCause(stage, note string) string {
	switch {
	case strings.HasPrefix(note, "合入冲突"):
		return "冲突"
	case stage == string(ledger.StageReview) || strings.HasPrefix(note, "审阅打回"):
		return "审阅打回"
	case stage == string(ledger.StageAccept) || strings.HasPrefix(note, "验收打回"):
		return "验收打回"
	case stage == string(ledger.StageMerge):
		return "检查没过"
	}
	return "交付检查未通过"
}

// lastBounce 取上次拉起之后最近一次交回：交回前的阶段与原因。
func lastBounce(ctx context.Context, q store.Querier, task string) (stage, note string, ok bool, err error) {
	var body string
	err = q.QueryRowContext(ctx, `SELECT body FROM task_events WHERE task = ? AND kind = 'bounce'
		AND id > (SELECT COALESCE(max(id), 0) FROM task_events WHERE task = ? AND kind = ?) ORDER BY id DESC LIMIT 1`,
		task, task, workers.RunKind).Scan(&body)
	if store.IsNotFound(err) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	var b struct {
		From ledger.State `json:"from"`
		Note string       `json:"note"`
	}
	if err := json.Unmarshal([]byte(body), &b); err != nil {
		return "", "", false, fmt.Errorf("任务 %s 的交回记录坏了：%w", task, err)
	}
	return string(b.From.Stage), b.Note, true, nil
}

// choose 定执行者：写死的核对能接；自动的按 Pick。wait 为真表示能接的都正忙，留在队列里等。
func (d *dispatcher) choose(ctx context.Context, t ledger.Task, o Options, exclude map[string]bool) (w workers.Resolved, wait bool, err error) {
	if o.Worker != "" && exclude == nil {
		w, err := workers.Resolve(ctx, d.env.DB, o.Worker)
		if err != nil {
			return w, false, err
		}
		if why := w.Rules.Refusal(o.Risk, false); why != "" {
			return w, false, api.Conflict("%s 接不了：%s", w.ID, why)
		}
		busy, err := busyTools(ctx, d.env.DB)
		if err != nil {
			return w, false, err
		}
		return w, w.Adapter.Exclusive && busy[w.Spec.Tool], nil
	}
	if exclude == nil {
		exclude = map[string]bool{}
	}
	for _, a := range o.Avoid {
		exclude[a] = true
	}
	v, err := d.view(ctx, t, o.Risk, exclude, o.Host)
	if err != nil {
		return w, false, err
	}
	if v.Recommended == "" {
		if v.Waiting {
			return w, true, nil
		}
		return w, false, api.Conflict("%s", v.Reason).WithNext("atrium workers")
	}
	w, err = workers.Resolve(ctx, d.env.DB, v.Recommended)
	return w, false, err
}

// busyTools 是在跑的执行者用到的工具。
func busyTools(ctx context.Context, q store.Querier) (map[string]bool, error) {
	rows, err := q.QueryContext(ctx, `SELECT worker FROM tasks WHERE status = 'running' AND stage = '' AND worker != '' LIMIT 1000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var w string
		if err := rows.Scan(&w); err != nil {
			return nil, err
		}
		if s, err := workers.ParseWorker(w); err == nil {
			out[s.Tool] = true
		}
	}
	return out, rows.Err()
}

type launchOpts struct {
	W       workers.Resolved
	Host    string
	Risk    string
	Secrets []string
	Why     string
	Cause   string   // Why 为 bounce 时的原因类别
	Session string   // 继续会话
	Pending []string // 继续时带的补充说明
}

type tellRow struct {
	ID   int64
	Text string
}

// tells 只取 upto 之后、还没即时送到的补充说明。
func tells(ctx context.Context, q store.Querier, task string, upto int64) ([]tellRow, error) {
	query := `SELECT id, body FROM task_events WHERE task = ? AND kind = 'tell' AND id > ?
		AND CAST(id AS TEXT) NOT IN (SELECT body FROM task_events WHERE task = ? AND kind = 'tell_sent') ORDER BY id LIMIT 50`
	args := []any{task, upto, task}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []tellRow
	for rows.Next() {
		var r tellRow
		if err := rows.Scan(&r.ID, &r.Text); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// bounceNotes 是上次拉起之后被交回的原因（交付检查、审阅、合入写的 note）。
func bounceNotes(ctx context.Context, q store.Querier, task string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT body FROM task_events WHERE task = ? AND kind = 'bounce'
		AND id > (SELECT COALESCE(max(id), 0) FROM task_events WHERE task = ? AND kind = ?) ORDER BY id LIMIT 5`,
		task, task, workers.RunKind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			return nil, err
		}
		var b struct {
			Note string `json:"note"`
		}
		if json.Unmarshal([]byte(body), &b) == nil && b.Note != "" {
			out = append(out, b.Note)
		}
	}
	return out, rows.Err()
}

// repoGuide 读目标仓库自己的约定 .agents/README.md：本机从任务工作树读，远程从本机的仓库克隆读；没有就空。
func repoGuide(data, repo, dir string) (string, error) {
	if repo == "" {
		return "", nil
	}
	root := dir
	if root == "" {
		local, _, err := RepoSource(data, repo)
		if err != nil {
			return "", err
		}
		root = local
	}
	b, err := os.ReadFile(filepath.Join(root, ".agents", "README.md"))
	if os.IsNotExist(err) {
		return "", nil
	}
	return string(b), err
}

func (d *dispatcher) remoteWaiter(p *proc, rr int) func() int {
	return func() int {
		exit, err := waitRemote(context.Background(), d.env, p.task, rr)
		if err != nil {
			d.env.Log.Error("等远程执行者退出失败", "task", p.task, "err", err)
			return workers.ExitUnknown
		}
		p.lost = exit.Lost
		if exit.Code == nil {
			return workers.ExitUnknown
		}
		return *exit.Code
	}
}

// record 记录结果：从队列拉起的转 running；记执行者与机器、拉起记录；删队列行。
func (d *dispatcher) record(ctx context.Context, t ledger.Task, run workers.Run) error {
	db := d.env.DB
	if t.Status == ledger.Queued {
		if _, err := ledger.Apply(ctx, db, t.ID, ledger.Event{Kind: ledger.Start}, actor, run.Worker+" 在 "+run.Host); err != nil {
			return err
		}
		if err := dropRow(ctx, db, t.ID); err != nil {
			return err
		}
	}
	if err := ledger.SetFacts(ctx, db, t.ID, ledger.Facts{Worker: &run.Worker, Host: &run.Host}, actor); err != nil {
		return err
	}
	raw, _ := json.Marshal(run)
	if err := ledger.Record(ctx, db, t.ID, workers.RunKind, actor, string(raw)); err != nil {
		return err
	}
	// 交付检查按登记的机器与目录查事实（gates.Workspace）；watch 按登记的进程看进展、判长时间没进展（watch.Track，只看本机目录）。
	wt, _ := json.Marshal(gates.Worktree{Host: run.Host, Dir: run.Dir})
	if err := ledger.Record(ctx, db, t.ID, gates.KindWorktree, actor, string(wt)); err != nil {
		return err
	}
	proc := watch.Proc{Role: "worker", PID: run.PID, Host: run.Host, Log: run.Log, At: run.At}
	if run.Host == LocalHost {
		proc.Dir = run.Dir
	}
	return watch.Track(ctx, db, t.ID, proc)
}

// track 登记进程并在后台等它退出。
func (d *dispatcher) track(p *proc, wait func() int) {
	d.mu.Lock()
	d.procs[p.task] = p
	d.mu.Unlock()
	if p.stdin != nil {
		go p.watchLive(func(uuid string) {
			if id, ok := strings.CutPrefix(uuid, "tell-"); ok {
				if err := ledger.Record(context.Background(), d.env.DB, p.task, "tell_sent", actor, id); err != nil {
					d.env.Log.Error("记补充说明送达失败", "task", p.task, "err", err)
				}
			}
		})
	}
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		code := wait()
		close(p.done)
		p.closeStdin()
		d.mu.Lock()
		if d.procs[p.task] == p {
			delete(d.procs, p.task)
		}
		d.mu.Unlock()
		if d.retired.Load() {
			return
		}
		err := ledger.EachTask(context.Background(), d.env.DB, "dispatch.exit", []*proc{p}, func(p *proc) string { return p.task }, func(p *proc) error {
			if err := d.exited(context.Background(), p, code); err != nil {
				return err
			}
			return noteUnknown(context.Background(), d.env.DB, p.task, p.run)
		})
		if err != nil {
			d.env.Log.Error("执行者退出后收尾发生全局错误", "task", p.task, "err", err)
			select {
			case d.fatal <- err:
			default:
			}
		}
		d.wake()
	}()
}

func (d *dispatcher) kill(ctx context.Context, p *proc) {
	if p.remote {
		if err := stopRemote(ctx, d.env, p.task); err != nil {
			d.env.Log.Error("结束远程执行者失败", "task", p.task, "err", err)
		}
		return
	}
	if err := platform.KillTree(p.run.PID); err != nil && platform.Alive(p.run.PID) {
		d.env.Log.Error("结束执行者失败", "task", p.task, "pid", p.run.PID, "err", err)
	}
}

// exited 是执行者退出后的收尾：判信号与结局，进入交付检查、判失败，或重试、换人、继续、重派。
// 任务已不在跑（watch 或人先收了尾）、或已换了一轮拉起，就不动。
// noteUnknown：这次拉起的日志有认不出的事件时记一条草稿（workers.ParseFinding 判）；草稿满了照常报错。
func noteUnknown(ctx context.Context, db *store.DB, task string, run workers.Run) error {
	tr, err := workers.ReadTrace(run.Worker, run.Log)
	if err != nil {
		return err
	}
	t, err := ledger.Get(ctx, db, task)
	if err != nil {
		return err
	}
	open, err := ledger.List(ctx, db, ledger.Filter{Class: workers.ParseClass, Limit: 500,
		Status: []ledger.Status{ledger.Draft, ledger.Todo, ledger.Queued, ledger.Running, ledger.Blocked}})
	if err != nil {
		return err
	}
	if in, ok := workers.ParseFinding(t, run.Worker, tr, open); ok {
		_, err = ledger.Add(ctx, db, in, actor)
	}
	return err
}

// switchHost 给换上的执行者挑机器：上一轮那台能接就留在那台（工作目录在那里），否则另挑；都接不了报冲突。
func (d *dispatcher) switchHost(ctx context.Context, t ledger.Task, w workers.Spec, prev string) (string, error) {
	need, err := hostNeed(ctx, d.env.DB, w, t)
	if err != nil {
		return "", err
	}
	c, err := pickHost(ctx, d.env, need, prev)
	if err != nil || c.Kind == "run" {
		return c.Host, err
	}
	why := c.Reason
	if c, err = pickHost(ctx, d.env, need, ""); err != nil || c.Kind == "run" {
		return c.Host, err
	}
	return "", api.Conflict("没有机器能接 %s：%s；%s", w, why, c.Reason)
}

func readHead(path string, n int) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	buf := make([]byte, n)
	k, _ := f.Read(buf)
	return string(buf[:k]), nil
}

// adopt 继续跟进服务重启前在跑的执行者：本机进程还活着就跟着等（查存活），已经没了就按日志收尾；远程的等代理报退出。
func (d *dispatcher) adopt(ctx context.Context) error {
	db := d.env.DB
	if err := hosts.RecoverLaunches(ctx, db); err != nil {
		return err
	}
	list, err := ledger.List(ctx, db, ledger.Filter{Status: []ledger.Status{ledger.Running}, Limit: 500})
	if err != nil {
		return err
	}
	return ledger.EachTask(ctx, db, "dispatch.adopt", list, func(t ledger.Task) string { return t.ID }, func(t ledger.Task) error {
		if t.Stage != ledger.StageNone || d.procOf(t.ID) != nil {
			return nil
		}
		run, err := workers.LastRun(ctx, db, t.ID)
		if err != nil {
			return err
		}
		if run == nil {
			return nil
		}
		w, err := workers.Resolve(ctx, db, run.Worker)
		if err != nil {
			return fmt.Errorf("继续跟进 %s：%w", t.ID, err)
		}
		p := &proc{task: t.ID, run: *run, adapter: w.Adapter, remote: run.Host != LocalHost, pending: map[string]bool{}, done: make(chan struct{})}
		d.adoptProc(p)
		return nil
	})
}

func jsonUnmarshal(s string, v any) error { return json.Unmarshal([]byte(s), v) }
