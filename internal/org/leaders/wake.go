package leaders

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/worktree"
)

// Launch 是一次唤醒要起的进程：用哪个执行者档案、提示词、工作目录、环境（已含负责人令牌）。
type Launch struct {
	Leader  string
	Profile string
	Prompt  string
	Dir     string
	Env     map[string]string
}

// Launcher 把一次唤醒翻成进程调用（不拉起，拉起、限时、结束由本包经 platform 做）。
// 由 workers／dispatch 接上：org 系的包不能引用它们。没接上时唤醒一律失败，连续失败后事件转交上一层。
type Launcher func(ctx context.Context, l Launch) (platform.Spec, error)

var (
	launcherMu sync.Mutex
	launcher   Launcher
)

// SetLauncher 接上拉起接口（workers 或 dispatch 在自己的 Module() 里调）。
func SetLauncher(l Launcher) {
	launcherMu.Lock()
	launcher = l
	launcherMu.Unlock()
}

func getLauncher() Launcher {
	launcherMu.Lock()
	defer launcherMu.Unlock()
	return launcher
}

// MaterialsOverview 取部门的资料总览：Routes 装配时接上 org.Overview（要数据目录）；单测里保持为空。
var MaterialsOverview = func(ctx context.Context, q store.Querier, dept string) (string, error) { return "", nil }

// hub 是本服务进程里负责人运行时的全部状态：令牌、在跑的唤醒、连续失败次数。
type hub struct {
	mu      sync.Mutex
	tokens  map[string]string // 令牌 → aN
	running map[string]bool
	fails   map[string]int
	tick    time.Duration
	batch   time.Duration
	timeout time.Duration
	wg      sync.WaitGroup
}

func newHub() *hub {
	return &hub{tokens: map[string]string{}, running: map[string]bool{}, fails: map[string]int{},
		tick: 5 * time.Second, batch: BatchDelay, timeout: WakeTimeout}
}

func (h *hub) issue(leader string) (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	t := "lt_" + hex.EncodeToString(raw)
	h.mu.Lock()
	h.tokens[t] = leader
	h.mu.Unlock()
	return t, nil
}

func (h *hub) revoke(t string) {
	h.mu.Lock()
	delete(h.tokens, t)
	h.mu.Unlock()
}

func (h *hub) auth(token string) (api.Actor, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if l, ok := h.tokens[token]; ok {
		return api.Actor{ID: l, Kind: "leader"}, true
	}
	return api.Actor{}, false
}

// wakeEnabled：只在缺省数据目录唤醒；隔离实例（测试、开发）要 ATRIUM_LEADER_WAKE=1 才唤醒，免得真起模型进程。
func wakeEnabled(data string, getenv func(string) string) bool {
	if getenv("ATRIUM_LEADER_WAKE") == "1" {
		return true
	}
	return !config.Paths{Data: data}.Isolated()
}

func (h *hub) run(ctx context.Context, env *app.Env) error {
	if !wakeEnabled(env.Paths.Data, os.Getenv) {
		env.Log.Info("负责人唤醒未开启（隔离数据目录；要开设 ATRIUM_LEADER_WAKE=1）")
		return nil
	}
	defer h.wg.Wait()
	t := time.NewTicker(h.tick)
	defer t.Stop()
	var nextPrune int64
	for {
		if now := store.Now(); now >= nextPrune {
			n, err := PruneWakes(ctx, env.DB, now-WakeRetention.Milliseconds())
			if err != nil {
				return fmt.Errorf("清理唤醒记录：%w", err)
			}
			if n > 0 {
				env.Log.Info("清理唤醒记录", "deleted", n)
			}
			nextPrune = now + time.Hour.Milliseconds()
		}
		if err := h.round(ctx, env); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// round 看一遍谁该唤醒，逐个在后台起。
func (h *hub) round(ctx context.Context, env *app.Env) error {
	pending, err := pendingByLeader(ctx, env.DB)
	if err != nil {
		return err
	}
	h.mu.Lock()
	due := Due(pending, h.running, store.Now(), h.batch)
	h.mu.Unlock()
	return app.Each(ctx, env.DB, due, func(p Pending) error {
		paused, err := h.paused(ctx, env, p.Leader)
		if err != nil {
			return err
		}
		if paused {
			return nil
		}
		h.mu.Lock()
		h.running[p.Leader] = true
		h.mu.Unlock()
		h.wg.Add(1)
		go func(p Pending) {
			defer h.wg.Done()
			h.wake(ctx, env, p)
			h.mu.Lock()
			delete(h.running, p.Leader)
			h.mu.Unlock()
		}(p)
		return nil
	}, func(p Pending, cause error) error {
		// 这一批无法在该负责人处处理，转秘书；原记录不删除，后续不再唤醒这位。
		env.Log.Warn("负责人待处理批次出错，转秘书", "leader", p.Leader, "err", cause)
		_, err := events.Retarget(ctx, env.DB, p.IDs, p.Leader, org.Secretary)
		return err
	})
}

func (h *hub) paused(ctx context.Context, env *app.Env, leader string) (bool, error) {
	lm, err := org.LeaderMap(ctx, env.DB)
	if err != nil {
		return false, err
	}
	var chain []string
	for _, d := range org.Led(lm, leader) {
		anc, err := org.Ancestors(ctx, env.DB, d)
		if err != nil {
			return false, err
		}
		chain = append(chain, anc...)
	}
	return env.Pause.Paused(ctx, pause.Scope{Orgs: chain})
}

// pendingByLeader 读发给负责人的、没确认的「要处理」事件（每位最多 MaxBatch 条）；知会不唤醒负责人。
func pendingByLeader(ctx context.Context, q store.Querier) ([]Pending, error) {
	rows, err := q.QueryContext(ctx, `SELECT target, id, at FROM events
		WHERE acked_at IS NULL AND level = 'act' AND target LIKE 'a%' ORDER BY id LIMIT ?`, MaxBatch*org.MaxLeaders)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Pending
	idx := map[string]int{}
	for rows.Next() {
		var target string
		var id, at int64
		if err := rows.Scan(&target, &id, &at); err != nil {
			return nil, err
		}
		i, ok := idx[target]
		if !ok {
			i = len(out)
			idx[target] = i
			out = append(out, Pending{Leader: target, Oldest: at})
		}
		if len(out[i].IDs) < MaxBatch {
			out[i].IDs = append(out[i].IDs, id)
		}
	}
	return out, rows.Err()
}

// wake 起一次负责人进程并收尾：这批全确认了算成功；否则记一次失败，连续 MaxFails 次就把没确认的转交上一层。
// 用上了执行者组合的唤醒都落一条唤醒记录；服务停下的不记。
func (h *hub) wake(ctx context.Context, env *app.Env, p Pending) {
	log := env.Log.With("leader", p.Leader)
	run, err := h.launch(ctx, env, p)
	if ctx.Err() != nil {
		return // 服务停下：不算这位的失败，下次起来重新唤醒
	}
	if err != nil {
		log.Warn("负责人唤醒失败", "err", err)
	}
	bg := context.WithoutCancel(ctx)
	left, lerr := unacked(bg, env.DB, p.Leader, p.IDs)
	if lerr != nil {
		log.Error("查这批事件是否确认失败", "err", lerr)
		return
	}
	h.mu.Lock()
	next, forward := Outcome(len(left), h.fails[p.Leader])
	h.fails[p.Leader] = next
	h.mu.Unlock()
	var to []string
	var ferr error
	switch {
	case forward:
		var n int64
		if to, n, ferr = forwardUp(bg, env.DB, p.Leader, left); ferr != nil {
			log.Error("转交上一层失败", "err", ferr)
		} else {
			log.Warn("负责人连续没处理完，事件已转交上一层", "to", to, "events", n)
		}
	case len(left) > 0:
		log.Warn("负责人这次没处理完", "left", len(left), "fails", next)
	}
	if run.profile == "" {
		return
	}
	if rerr := h.record(bg, env, p, run, err, len(left), to, ferr); rerr != nil {
		log.Error("记唤醒记录失败", "err", rerr)
	}
}

// wakeRun 是一次唤醒拉起的情况：用的组合、第几次连续尝试、日志里这次的起点、进程起没起来与起止时间。
type wakeRun struct {
	profile string
	n       int
	log     string
	from    int64
	started bool
	begin   int64
	end     int64
}

// record 落唤醒记录：日志段交 WakeUsage 取模型与用量，取不到只记日志、用量留空，不挡记录落库。
func (h *hub) record(ctx context.Context, env *app.Env, p Pending, run wakeRun, err error, left int, to []string, ferr error) error {
	outcome, reason := WakeResult(run.started, err, left, len(p.IDs), to, ferr)
	w := Wake{Leader: p.Leader, Profile: run.profile, N: run.n, Outcome: outcome, Reason: reason, At: store.Now()}
	if run.started {
		d := run.end - run.begin
		w.DurationMS = &d
		seg, serr := readFrom(run.log, run.from)
		if serr == nil {
			w.Model, w.Usage, serr = WakeUsage(ctx, env.DB, run.profile, seg)
		}
		if serr != nil {
			env.Log.Warn("负责人唤醒的用量取不到", "leader", p.Leader, "err", serr)
			w.Model, w.Usage = "", ""
		}
	}
	return recordWake(ctx, env.DB, w)
}

func readFrom(path string, from int64) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := f.Seek(from, io.SeekStart); err != nil {
		return "", err
	}
	raw, err := io.ReadAll(f)
	return string(raw), err
}

// launch 签发令牌、组提示词、经 Launcher 与 platform 拉起，等到退出或超时；令牌在返回时作废。
func (h *hub) launch(ctx context.Context, env *app.Env, p Pending) (wakeRun, error) {
	var run wakeRun
	who, err := org.GetIdentity(ctx, env.DB, p.Leader)
	if err != nil {
		return run, err
	}
	h.mu.Lock()
	fails := h.fails[p.Leader]
	h.mu.Unlock()
	run.profile, run.n = PickWorker(who.Workers, fails), fails+1
	if run.profile == "" {
		return run, fmt.Errorf("%s 没有登记执行者组合", who.ID)
	}
	l := getLauncher()
	if l == nil {
		return run, errors.New("拉起接口还没接上（leaders.SetLauncher）")
	}
	prompt, err := buildPrompt(ctx, env.DB, who, p.IDs)
	if err != nil {
		return run, err
	}
	dir := filepath.Join(env.Paths.Data, "leaders", who.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return run, err
	}
	// 会话临时目录：同一负责人同时只有一次唤醒，每次先清空；退出后按它回收残留进程。
	tmp := filepath.Join(dir, "tmp")
	if err := worktree.RemoveTemp(tmp); err != nil {
		return run, err
	}
	if err := os.MkdirAll(tmp, 0o700); err != nil {
		return run, err
	}
	token, err := h.issue(who.ID)
	if err != nil {
		return run, err
	}
	defer h.revoke(token)
	spec, err := l(ctx, Launch{Leader: who.ID, Profile: run.profile, Prompt: prompt, Dir: dir,
		Env: leaderEnv(platform.EnvMap(os.Environ()), token, env.Paths.Data, tmp)})
	if err != nil {
		return run, err
	}
	run.log = filepath.Join(dir, "wake.log")
	logf, err := platform.OpenLog(run.log)
	if err != nil {
		return run, err
	}
	defer logf.Close()
	if run.from, err = logf.Seek(0, io.SeekCurrent); err != nil {
		return run, err
	}
	fmt.Fprintf(logf, "\n=== %s 唤醒 %s（%s），事件 %v\n", time.Now().Format(time.RFC3339), who.ID, run.profile, p.IDs)
	spec.Stdout, spec.Stderr, spec.Detached = logf, logf, true
	if spec.Dir == "" {
		spec.Dir = dir
	}
	run.begin = store.Now()
	cmd, err := platform.Start(spec)
	if err != nil {
		return run, err
	}
	run.started = true
	err = waitLimited(ctx, cmd, tmp, h.timeout)
	run.end = store.Now()
	return run, err
}

// waitLimited 等进程退出并回收会话残留；超时或服务停下就结束整棵进程树。
func waitLimited(ctx context.Context, cmd *exec.Cmd, tmp string, limit time.Duration) error {
	done := make(chan error, 1)
	go func() { done <- platform.WaitSession(cmd, tmp) }()
	timer := time.NewTimer(limit)
	defer timer.Stop()
	select {
	case err := <-done:
		return err
	case <-timer.C:
		platform.KillTree(cmd.Process.Pid)
		<-done
		return fmt.Errorf("超过 %s 没结束，已结束", limit)
	case <-ctx.Done():
		platform.KillTree(cmd.Process.Pid)
		<-done
		return ctx.Err()
	}
}

// leaderEnv：执行者白名单环境（临时目录是这位负责人的会话临时目录），去掉 ATRIUM_WORKER（负责人不是执行者），加本次令牌与数据目录；
// 服务所在目录排进 PATH 最前，atrium 命令就是这个服务的同一个二进制。
func leaderEnv(base map[string]string, token, data, tmp string) map[string]string {
	env := platform.WorkerEnv(runtime.GOOS, base, tmp)
	delete(env, "ATRIUM_WORKER")
	env["ATRIUM_LEADER_TOKEN"] = token
	env["ATRIUM_DATA"] = data
	platform.SelfOnPath(env)
	return env
}

func buildPrompt(ctx context.Context, q store.Querier, who org.Identity, ids []int64) (string, error) {
	in := PromptInput{Leader: who}
	roster, err := org.Leaders(ctx, q)
	if err != nil {
		return "", err
	}
	in.Names = make(map[string]string, len(roster))
	for _, identity := range roster {
		in.Names[identity.ID] = identity.Name
	}
	ps, err := org.Parents(ctx, q)
	if err != nil {
		return "", err
	}
	if in.Global, err = org.Principles(); err != nil {
		return "", err
	}
	skills, err := org.Skills(ctx, q)
	if err != nil {
		return "", err
	}
	in.Skills = org.SkillIndex(skills, "")
	lm, err := org.LeaderMap(ctx, q)
	if err != nil {
		return "", err
	}
	for _, d := range who.Depts {
		dept, err := org.Get(ctx, q, d)
		if err != nil {
			return "", err
		}
		b := DeptBrief{Dept: dept}
		if b.Path, err = org.Ancestors(ctx, q, d); err != nil {
			return "", err
		}
		if b.Chain, err = org.Chain(ctx, q, d); err != nil {
			return "", err
		}
		if b.Materials, err = MaterialsOverview(ctx, q, d); err != nil {
			return "", err
		}
		for _, c := range org.Covered(ps, lm, d) {
			sub, err := org.Get(ctx, q, c)
			if err != nil {
				return "", err
			}
			b.Covered = append(b.Covered, sub)
		}
		in.Depts = append(in.Depts, b)
	}
	memo, err := org.GetMemo(ctx, q, who.ID)
	if err != nil {
		return "", err
	}
	in.Memo = memo.Body
	if in.Events, err = eventRows(ctx, q, ids); err != nil {
		return "", err
	}
	in.Upstream = Upstream(ps, lm, who.ID, "")
	return Prompt(in), nil
}

func idArgs(ids []int64) (string, []any) {
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return "(?" + strings.Repeat(", ?", len(ids)-1) + ")", args
}

func eventRows(ctx context.Context, q store.Querier, ids []int64) ([]Event, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	in, args := idArgs(ids)
	rows, err := q.QueryContext(ctx, `SELECT id, at, kind, COALESCE(task, ''), COALESCE(department, ''), body
		FROM events WHERE id IN `+in+` ORDER BY id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.At, &e.Kind, &e.Task, &e.Dept, &e.Body); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// unacked 返回这批里仍发给 leader、没确认的事件编号。
func unacked(ctx context.Context, q store.Querier, leader string, ids []int64) ([]int64, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	in, args := idArgs(ids)
	rows, err := q.QueryContext(ctx, `SELECT id FROM events WHERE acked_at IS NULL AND target = ? AND id IN `+in,
		append([]any{leader}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// forwardUp 把 leader 没确认的事件逐条转交：从事件所属部门往上、跳过这位的最近负责人，没有就秘书。
// 返回转交到的负责人与件数；出错时事务整体回滚，不返回目标。
func forwardUp(ctx context.Context, db *store.DB, leader string, ids []int64) ([]string, int64, error) {
	ps, err := org.Parents(ctx, db)
	if err != nil {
		return nil, 0, err
	}
	lm, err := org.LeaderMap(ctx, db)
	if err != nil {
		return nil, 0, err
	}
	rows, err := eventRows(ctx, db, ids)
	if err != nil {
		return nil, 0, err
	}
	byTarget := map[string][]int64{}
	var targets []string
	for _, e := range rows {
		to := Upstream(ps, lm, leader, e.Dept)
		if _, ok := byTarget[to]; !ok {
			targets = append(targets, to)
		}
		byTarget[to] = append(byTarget[to], e.ID)
	}
	var total int64
	err = db.Tx(ctx, func(tx *sql.Tx) error {
		for _, to := range targets {
			n, err := events.Retarget(ctx, tx, byTarget[to], leader, to)
			if err != nil {
				return err
			}
			total += n
		}
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	return targets, total, nil
}
