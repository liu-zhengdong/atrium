// Package dispatch 是派活：一个派活队列（状态 queued 的任务，按优先级、入队先后取）、挑执行者（档案能接 + 额度富余 +
// 不正忙）、挑机器（本机优先、空位最多），在任务目录的 git worktree 里拉起执行者，退出后按信号重试、换人、续上或交关卡。
//
// 命令：task run、task tell（POST /api/tasks/{id}/tell）、task log；停下是 ledger 的 task stop（转受阻，派活循环结束它的执行者）。
// 状态只经 ledger.Apply：入队 Enqueue、拉起 Start、退出 ExitOK（进关卡，gates 接手）或 ExitFail、停下 Block。
// 拉起记录以任务经历 kind "launch"（workers.Run）存，gates、watch 读它。每次自主动作前问 Pause。
package dispatch

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

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

// dispatcher 是服务进程里派活的内存状态：本机在跑的执行者进程。
type dispatcher struct {
	env   *app.Env
	mu    sync.Mutex
	procs map[string]*proc
	kick  chan struct{}
	wg    sync.WaitGroup
	// retired：本实例的派活循环已退出（服务停下或平滑重启）。之后看到的退出不收尾，交给新服务接管时按日志收。
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
		cur = &dispatcher{env: env, procs: map[string]*proc{}, kick: make(chan struct{}, 1)}
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

// Run 是派活循环：先接管服务重启前在跑的执行者，再等账本变化或定时，每次按队列顺序派。
func Run(ctx context.Context, env *app.Env) error {
	d := get(env)
	defer d.retired.Store(true)
	if err := d.adopt(ctx); err != nil {
		return err
	}
	for {
		ch := ledger.Changed()
		if err := d.reap(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if err := d.pump(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ch:
		case <-d.kick:
		case <-time.After(10 * time.Second): // 暂停解除、额度恢复、机器空出来不经账本
		}
	}
}

func isAPI(err error) bool {
	var ae *api.Error
	return errors.As(err, &ae)
}

// reap 结束已不该跑的执行者：任务被人改成受阻、取消、完成（task set），或被 watch 收了尾，进程还活着就结束它。
func (d *dispatcher) reap(ctx context.Context) error {
	d.mu.Lock()
	list := make([]*proc, 0, len(d.procs))
	for _, p := range d.procs {
		list = append(list, p)
	}
	d.mu.Unlock()
	for _, p := range list {
		if p.stopReason() != "" {
			continue
		}
		t, err := ledger.Get(ctx, d.env.DB, p.task)
		if err != nil {
			return err
		}
		last, err := workers.LastRun(ctx, d.env.DB, p.task)
		if err != nil {
			return err
		}
		if t.Status == ledger.Running && t.Stage == ledger.StageNone && last != nil && last.N == p.run.N {
			continue
		}
		p.setStop("gone")
		d.kill(ctx, p)
	}
	return nil
}

// pump 按队列顺序派一轮。依赖还没完成的跳过，依赖失败或取消的转受阻；单件任务派不出去的原因（没人能接、仓库不对……）
// 转受阻交处理人，其余错误让服务停下。
func (d *dispatcher) pump(ctx context.Context) error {
	items, err := queued(ctx, d.env.DB)
	if err != nil {
		return err
	}
	for _, it := range items {
		if ctx.Err() != nil {
			return nil
		}
		deps, err := ledger.Deps(ctx, d.env.DB, it.Task.ID)
		if err != nil {
			return err
		}
		// 有失败或取消的依赖就转受阻（等不到了）；还有没完成的留在队列里，这一轮跳过。
		waiting, broken := ledger.DepGate(deps)
		switch {
		case len(broken) > 0:
			err = d.block(ctx, it.Task.ID, "依赖的 "+ledger.BrokenText(broken)+"，不再自动派")
		case len(waiting) > 0:
			continue
		default:
			if err = d.try(ctx, it); err != nil && isAPI(err) {
				err = d.block(ctx, it.Task.ID, "派不出去："+err.Error())
			}
		}
		if err != nil {
			return err
		}
	}
	return nil
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
		return api.Conflict("没有机器能接：%s", choice.Reason)
	}
	if p, err := d.paused(ctx, t, choice.Host); err != nil || p {
		return err
	}
	o := launchOpts{W: w, Host: choice.Host, Risk: it.Opts.Risk, Secrets: it.Opts.Secrets, Why: workers.WhyFirst}
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
	return "关卡没过"
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
		if why := w.Rules.Refusal(o.Risk); why != "" {
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
	v, err := d.view(ctx, t, o.Risk, exclude)
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

// view 收集事实并挑执行者（task run --dry-run 与自动派活同一份）。
func (d *dispatcher) view(ctx context.Context, t ledger.Task, risk string, exclude map[string]bool) (PickView, error) {
	db := d.env.DB
	var preferred []string
	if t.Skill != "" {
		s, err := skillOf(ctx, d.env, t.Skill)
		if err != nil {
			return PickView{}, err
		}
		preferred = s.Workers
	}
	catalog, err := workers.Catalog(ctx, db)
	if err != nil {
		return PickView{}, err
	}
	loggedOut, err := localLoggedOut(ctx, db)
	if err != nil {
		return PickView{}, err
	}
	marks, err := workers.Marks(ctx, db, store.Now())
	if err != nil {
		return PickView{}, err
	}
	stats, err := workers.Stats(ctx, db)
	if err != nil {
		return PickView{}, err
	}
	var facts []Fact
	seen := map[string]bool{}
	iso := isolated(d.env)
	for i, id := range append(slices.Clone(preferred), catalog...) {
		r, err := workers.Resolve(ctx, db, id)
		if err != nil {
			if !isAPI(err) {
				return PickView{}, err
			}
			if !seen[id] {
				facts = append(facts, Fact{ID: id, Problem: err.Error(), Installed: true})
				seen[id] = true
			}
			continue
		}
		if seen[r.ID] {
			continue
		}
		seen[r.ID] = true
		f := Fact{ID: r.ID, Tool: r.Spec.Tool, Model: r.Spec.Model, Account: accountOf(r.Spec.Tool), Trust: r.Rules.EffectiveTrust(),
			MaxRisk: r.Rules.EffectiveMaxRisk(), Refusal: r.Rules.Refusal(risk), Installed: workers.Installed(r.Adapter),
			Exclusive: r.Adapter.Exclusive, Fails: workers.Fails(stats[workers.Combo(r.ID)], ShakyWindow)}
		if _, builtin := workers.Builtin(r.Spec.Tool); iso && builtin {
			f.Unavailable = "隔离实例（ATRIUM_DATA 不是缺省目录）不自动挑内置工具"
		} else if m, ok := workers.Blocked(marks, r.Spec.Tool, r.Spec.Model, LocalHost); ok {
			f.Unavailable = "本机不可用：" + m.Text()
		} else if loggedOut[r.Spec.Tool] {
			f.Unavailable = "没登录：本机的 " + r.Spec.Tool + " 没登录（atrium host ls " + LocalHost + "）"
		}
		if i < len(preferred) {
			f.Preferred = i + 1
		}
		if err := r.Check(); err != nil {
			f.Problem = err.Error()
		}
		facts = append(facts, f)
	}
	req, err := requirement(ctx, db, t.ID)
	if err != nil {
		return PickView{}, err
	}
	for i := range facts {
		if why := req.refusal(facts[i]); why != "" && facts[i].Refusal == "" {
			facts[i].Refusal = why
		}
	}
	sp, err := spares(ctx, d.env)
	if err != nil {
		return PickView{}, err
	}
	busy, err := busyTools(ctx, db)
	if err != nil {
		return PickView{}, err
	}
	return Pick(PickInput{Risk: risk, Priority: t.Priority, Facts: facts, Spares: sp, Busy: busy, Exclude: exclude}), nil
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
	Session string   // 续上会话
	Pending []string // 续上时带的捎话
}

type tellRow struct {
	ID   int64
	Text string
}

// tells 取捎话：pendingOnly 时只取 upto 之后、还没即时送到的。
func tells(ctx context.Context, q store.Querier, task string, upto int64, pendingOnly bool) ([]tellRow, error) {
	query := `SELECT id, body FROM (SELECT id, body FROM task_events WHERE task = ? AND kind = 'tell' ORDER BY id DESC LIMIT 20) ORDER BY id`
	args := []any{task}
	if pendingOnly {
		query = `SELECT id, body FROM task_events WHERE task = ? AND kind = 'tell' AND id > ?
			AND CAST(id AS TEXT) NOT IN (SELECT body FROM task_events WHERE task = ? AND kind = 'tell_sent') ORDER BY id LIMIT 50`
		args = []any{task, upto, task}
	}
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

// bounceNotes 是上次拉起之后被交回的原因（关卡、审阅、合入写的 note）。
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

// launch 拉起一次执行者：备好工作目录与提示词、算出进程调用、白名单环境加凭据、落账、跟着等它退出。
func (d *dispatcher) launch(ctx context.Context, t ledger.Task, o launchOpts) error {
	db, data := d.env.DB, d.env.Paths.Data
	remote := o.Host != LocalHost
	var dir, branch string
	var err error
	if !remote {
		if dir, branch, err = Workdir(ctx, data, t.ID, t.Repo, t.Dir); err != nil {
			if isAPI(err) {
				return err
			}
			return api.Conflict("准备工作目录失败：%v", err)
		}
	} else if t.Repo != "" {
		branch = Branch(t.ID)
	}
	last, err := workers.LastRun(ctx, db, t.ID)
	if err != nil {
		return err
	}
	n := 1
	if last != nil {
		n = last.N + 1
	}
	td := TaskDir(data, t.ID)
	if err := os.MkdirAll(td, 0o700); err != nil {
		return err
	}
	secrets := o.Secrets
	in := PromptInput{Task: t.ID, Org: t.Org, Title: t.Title, Detail: t.Detail, Profile: o.W.Body, Repo: t.Repo, Dir: t.Dir, Branch: branch}
	if in.Origin, err = gates.Origin(ctx, gates.NewExec(), t.Repo); err != nil {
		return err
	}
	if in.Global, err = org.Principles(); err != nil {
		return err
	}
	if t.Org != "" {
		chain, err := org.Chain(ctx, db, t.Org)
		if err != nil {
			return err
		}
		for _, p := range chain {
			in.Points = append(in.Points, org.ChainLine(p))
		}
		in.Points = append(in.Points, org.PointsOver(chain)...)
	}
	if t.Skill != "" {
		s, err := skillOf(ctx, d.env, t.Skill)
		if err != nil {
			return err
		}
		in.Skill, secrets = t.Skill, union(secrets, s.Secrets)
	}
	if in.Skills, err = skillIndex(ctx, d.env, t.Skill); err != nil {
		return err
	}
	all, err := tells(ctx, db, t.ID, 0, false)
	if err != nil {
		return err
	}
	var upto int64
	for _, tr := range all {
		in.Tells, upto = append(in.Tells, tr.Text), tr.ID
	}
	if in.Bounces, err = bounceNotes(ctx, db, t.ID); err != nil {
		return err
	}
	if in.Guide, err = repoGuide(data, t.Repo, dir); err != nil {
		return err
	}
	prompt := BuildPrompt(in)
	if o.Session != "" {
		prompt = ResumePrompt(o.Pending)
	}
	promptFile := filepath.Join(td, fmt.Sprintf("prompt-%d.md", n))
	if err := os.WriteFile(promptFile, []byte(prompt), 0o600); err != nil {
		return err
	}
	req := o.W.Request(prompt, promptFile, dir)
	req.Task, req.Session = t.ID, o.Session
	req.Live = o.W.Adapter.Tell == workers.TellStdin && o.Session == "" && !remote
	extra, err := secretEnv(ctx, d.env, t.Org, secrets)
	if err != nil {
		return err
	}
	if key := o.W.Rules.EndpointKey; key != "" {
		v, err := secretEnv(ctx, d.env, t.Org, []string{key})
		if err != nil {
			return err
		}
		extra[o.W.Endpoint().KeyEnv] = v[key]
	}
	token, err := issueWorkerToken(d.env, t.ID, n)
	if err != nil {
		return err
	}
	run := workers.Run{N: n, Why: o.Why, Cause: o.Cause, Worker: o.W.ID, Host: o.Host, Dir: dir, Branch: branch,
		Log: filepath.Join(td, fmt.Sprintf("run-%d.log", n)), Risk: o.Risk, Secrets: secrets, TellsUpto: upto, At: store.Now()}
	p := &proc{task: t.ID, adapter: o.W.Adapter, remote: remote, pending: map[string]bool{}, done: make(chan struct{})}
	var wait func() int
	if remote {
		clone := ""
		if t.Repo != "" {
			repo, err := RemoteRepo(ctx, t.Repo)
			if err != nil {
				return api.Conflict("%s 派不到远程：%v", t.ID, err)
			}
			if _, clone, err = RepoSource(data, repo); err != nil {
				return err
			}
		}
		rr, pid, rdir, err := launchRemote(ctx, d.env, o.Host, Remote{Task: t.ID, Tool: o.W.Spec.Tool, Request: req, Repo: clone,
			Branch: branch, Base: "main", Env: extra, Token: token, Log: run.Log})
		if err != nil {
			return err
		}
		run.PID, run.RemoteRun, run.Dir = pid, rr, rdir
		wait = d.remoteWaiter(t.ID, rr)
	} else {
		cmdWait, pid, stdin, err := startLocal(o.W.Spec.Tool, req, extra, conn{fmt.Sprintf("http://127.0.0.1:%d", d.env.Port), token}, run.Log, prompt, n)
		if err != nil {
			return err
		}
		run.PID, p.stdin, wait = pid, stdin, cmdWait
	}
	p.run = run
	if err := d.record(ctx, t, run); err != nil {
		d.kill(context.WithoutCancel(ctx), p)
		wait()
		return err
	}
	d.track(p, wait)
	return nil
}

// conn 是执行者的命令行连回服务用的：服务地址与本次拉起的执行者令牌。
type conn struct{ server, token string }

// startLocal 在本机拉起：白名单环境（带 ATRIUM_WORKER=1）+ 工具要的变量 + 凭据 + 连回服务的地址与令牌；
// 服务所在目录排进 PATH 最前（atrium 就是服务这个二进制）；日志直接写文件（服务重启不影响执行者）。
func startLocal(tool string, req workers.Request, extra map[string]string, c conn, log, prompt string, n int) (wait func() int, pid int, stdin *os.File, err error) {
	l, err := workers.Build(tool, req)
	if err != nil {
		return nil, 0, nil, err
	}
	env := platform.WorkerEnv(runtime.GOOS, platform.EnvMap(os.Environ()))
	for k, v := range l.Env {
		env[k] = v
	}
	for k, v := range extra {
		if _, taken := env[k]; taken {
			return nil, 0, nil, api.Usage("凭据 %s 会盖掉执行者环境里已有的变量，换个名字", k)
		}
		env[k] = v
	}
	env["ATRIUM_TASK"] = req.Task
	env["ATRIUM_SERVER"], env["ATRIUM_WORKER_TOKEN"] = c.server, c.token
	platform.SelfOnPath(env)
	exe, err := platform.LookPath(l.Exe, env)
	if err != nil {
		return nil, 0, nil, api.Conflict("没装 %s：%v", l.Exe, err)
	}
	logf, err := platform.OpenLog(log)
	if err != nil {
		return nil, 0, nil, err
	}
	defer logf.Close()
	var in *os.File
	switch {
	case l.Live:
		r, w, err := os.Pipe()
		if err != nil {
			return nil, 0, nil, err
		}
		defer r.Close()
		if _, err := w.Write(workers.UserLine(prompt, fmt.Sprintf("prompt-%d", n))); err != nil {
			w.Close()
			return nil, 0, nil, err
		}
		in, stdin = r, w
	case l.StdinFile != "":
		f, err := os.Open(l.StdinFile)
		if err != nil {
			return nil, 0, nil, err
		}
		defer f.Close()
		in = f
	}
	spec := platform.Spec{Path: exe, Args: l.Args, Dir: l.Dir, Env: env, Stdout: logf, Stderr: logf, Detached: true}
	if in != nil {
		spec.Stdin = in
	}
	cmd, err := platform.Start(spec)
	if err != nil {
		if stdin != nil {
			stdin.Close()
		}
		return nil, 0, nil, err
	}
	return func() int {
		if err := cmd.Wait(); err != nil && cmd.ProcessState == nil {
			return workers.ExitUnknown
		}
		return cmd.ProcessState.ExitCode()
	}, cmd.Process.Pid, stdin, nil
}

func (d *dispatcher) remoteWaiter(task string, rr int) func() int {
	return func() int {
		code, err := waitRemote(context.Background(), d.env, task, rr)
		if err != nil {
			d.env.Log.Error("等远程执行者退出失败", "task", task, "err", err)
			return workers.ExitUnknown
		}
		return code
	}
}

// record 落账：从队列拉起的转 running；记执行者与机器、拉起记录；删队列行。
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
	// 关卡按登记的机器与目录查事实（gates.Workspace）；watch 按登记的进程看进展、判卡死（watch.Track，只看本机目录）。
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
					d.env.Log.Error("记捎话送达失败", "task", p.task, "err", err)
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
		if err := d.exited(context.Background(), p, code); err != nil {
			d.env.Log.Error("执行者退出后收尾失败", "task", p.task, "err", err)
		}
		if err := noteUnknown(context.Background(), d.env.DB, p.task, p.run); err != nil {
			d.env.Log.Error("记日志解析草稿失败", "task", p.task, "err", err)
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

// tries 数这一轮（最近一次从队列取出之后）同一执行者重试、换人各几次，以及试过的执行者。
func tries(runs []workers.Run) (same, switches int, tried map[string]bool) {
	tried = map[string]bool{}
	for i := len(runs) - 1; i >= 0; i-- {
		r := runs[i]
		tried[r.Worker] = true
		switch r.Why {
		case workers.WhySame:
			same++
		case workers.WhySwitch:
			switches++
		case workers.WhyFirst, workers.WhyBounce: // 交回后是新的一轮
			return
		}
	}
	return
}

// exited 是执行者退出后的收尾：判信号与结局，交关卡、判失败，或重试、换人、续上、重派。
// 任务已不在跑（watch 或人先收了尾）、或已换了一轮拉起，就不动。
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
		return nil
	}
	tail, err := workers.Tail(p.run.Log, workers.TailBytes)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	head, err := readHead(p.run.Log, 64*1024)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	pending, err := tells(ctx, db, p.task, p.run.TellsUpto, true)
	if err != nil {
		return err
	}
	runs, err := workers.Runs(ctx, db, p.task, 50)
	if err != nil {
		return err
	}
	same, switches, tried := tries(runs)
	sig := workers.Classify(code, tail, time.Now())
	session := p.adapter.SessionOf(head)
	route := RouteExit(ExitInput{Code: code, Signal: sig, Ending: p.adapter.Ended(tail), StopFor: p.stopReason(),
		Same: same, Switches: switches, Pending: len(pending), CanResume: p.adapter.CanResume() && session != ""})
	marked, err := markUnavailable(ctx, db, p.run, sig)
	if err != nil {
		return err
	}
	if reply := p.adapter.LastReply(tail); reply != "" {
		if err := ledger.Record(ctx, db, p.task, gates.KindResult, actor, reply); err != nil {
			return err
		}
	}
	note := route.Reason
	if sig.Evidence != "" {
		note += "（" + sig.Evidence + "）"
	}
	note += marked
	exit := workers.Exit{N: p.run.N, Model: workers.ModelOf(p.run.Worker, head), Outcome: workers.OutcomeOf(sig, route.Do != "fail"), Reason: note}
	if err := recordExit(ctx, db, p.task, exit); err != nil {
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
	case "requeue": // 重新挑执行者与机器，避开刚标的不可用
		if err := apply(ledger.ExitFail, note); err != nil {
			return err
		}
		_, err := Enqueue(ctx, d.env, p.task, Options{Risk: p.run.Risk, Secrets: p.run.Secrets}, actor)
		if err != nil && isAPI(err) {
			return ledger.Note(ctx, db, p.task, actor, "重新排队失败："+err.Error())
		}
		return err
	}
	if paused, err := d.paused(ctx, t, p.run.Host); err != nil || paused {
		if err != nil {
			return err
		}
		return apply(ledger.Block, note+"；停机中没有重新拉起，恢复后 atrium task run "+p.task)
	}
	o := launchOpts{Host: p.run.Host, Risk: p.run.Risk, Secrets: p.run.Secrets}
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
		var wait bool
		o.W, wait, err = d.choose(ctx, t, Options{Risk: p.run.Risk}, tried)
		if err == nil && wait {
			err = api.Conflict("能换的执行者都正忙")
		}
		o.Why = workers.WhySwitch
		if err == nil {
			o.Host, err = d.switchHost(ctx, t, o.W.Spec, cmp.Or(p.run.Host, LocalHost))
		}
	}
	if err == nil {
		err = d.launch(ctx, t, o)
	}
	if err != nil {
		if !isAPI(err) {
			return err
		}
		return apply(ledger.ExitFail, note+"；重新拉起失败："+err.Error())
	}
	return ledger.Note(ctx, db, p.task, actor, "执行者退出："+note+"；已重新拉起（"+o.Why+"，"+o.W.ID+"）")
}

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

// recordExit 记这次拉起的结果（workers 按拉起统计用）。
func recordExit(ctx context.Context, q store.Querier, task string, x workers.Exit) error {
	raw, _ := json.Marshal(x)
	return ledger.Record(ctx, q, task, workers.ExitKind, actor, string(raw))
}

// markUnavailable 按退出信号把这一轮的「工具+模型@机器」标成不可用，返回写进任务备注的一句；不是可用性信号返回空。
func markUnavailable(ctx context.Context, db *store.DB, run workers.Run, sig workers.Signal) (string, error) {
	w, err := workers.ParseWorker(run.Worker)
	if err != nil {
		return "", err
	}
	m, ok := workers.MarkOf(sig, w, cmp.Or(run.Host, LocalHost), time.Now())
	if !ok {
		return "", nil
	}
	if err := workers.SetMark(ctx, db, m); err != nil {
		return "", err
	}
	return "；已标记 " + m.Target() + " 不可用（" + m.Text() + "）", nil
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

// adopt 接管服务重启前在跑的执行者：本机进程还活着就跟着等（查存活），已经没了就按日志收尾；远程的等代理报退出。
func (d *dispatcher) adopt(ctx context.Context) error {
	db := d.env.DB
	list, err := ledger.List(ctx, db, ledger.Filter{Status: []ledger.Status{ledger.Running}, Limit: 500})
	if err != nil {
		return err
	}
	for _, t := range list {
		if t.Stage != ledger.StageNone || d.procOf(t.ID) != nil {
			continue
		}
		run, err := workers.LastRun(ctx, db, t.ID)
		if err != nil {
			return err
		}
		if run == nil {
			continue
		}
		w, err := workers.Resolve(ctx, db, run.Worker)
		if err != nil {
			return fmt.Errorf("接管 %s：%w", t.ID, err)
		}
		p := &proc{task: t.ID, run: *run, adapter: w.Adapter, remote: run.Host != LocalHost, pending: map[string]bool{}, done: make(chan struct{})}
		if p.remote {
			d.track(p, d.remoteWaiter(t.ID, run.RemoteRun))
			continue
		}
		pid := run.PID
		d.track(p, func() int {
			for platform.Alive(pid) {
				time.Sleep(2 * time.Second)
			}
			return workers.ExitUnknown
		})
	}
	return nil
}

func jsonUnmarshal(s string, v any) error { return json.Unmarshal([]byte(s), v) }
