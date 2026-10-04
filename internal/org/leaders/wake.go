package leaders

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Launch 是一次唤醒要起的进程：用哪个执行者档案、提示词、工作目录、环境（已含负责人令牌）。
type Launch struct {
	Leader  string
	Profile string
	Prompt  string
	Dir     string
	Env     map[string]string
	Attempt *Attempt
}

// Attempt 是注入边界的一次运行结果。Finish 只判退出及写共用不可用标记；
// 事件确认、身份、权限、停止与次数仍由 leaders 拥有，不存第二份状态。
type Attempt struct {
	Preferred []string
	Tried     []string
	Profile   string
	Finish    func(context.Context, string, int, bool) (retry bool, reason string, err error)
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
		return env.DB.Tx(ctx, func(tx *sql.Tx) error {
			_, err := events.Retarget(ctx, tx, p.IDs, p.Leader, org.Secretary)
			return err
		})
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
	attempt := &Attempt{}
	for {
		paused, perr := h.paused(ctx, env, p.Leader)
		if perr != nil {
			log.Error("查停机状态失败", "err", perr)
			return
		}
		if paused || ctx.Err() != nil {
			return
		}
		run, err := h.launch(ctx, env, p, attempt)
		if ctx.Err() != nil {
			return // 服务停下：不算这位的失败，下次起来重新唤醒
		}
		if err != nil {
			log.Warn("负责人唤醒失败", "err", err)
		}
		bg := context.WithoutCancel(ctx)
		if run.started {
			if terr := recordTaskWakes(bg, env.DB, p); terr != nil {
				log.Warn("记负责人唤醒经历失败", "err", terr)
			}
		}
		left, lerr := unacked(bg, env.DB, p.Leader, p.IDs)
		if lerr != nil {
			log.Error("查这批事件是否确认失败", "err", lerr)
			return
		}
		retry := false
		if run.started && attempt.Finish != nil {
			paused, perr := h.paused(bg, env, p.Leader)
			if perr != nil {
				log.Error("查停机状态失败", "err", perr)
				return
			}
			if paused {
				return
			}
			seg, serr := readFrom(run.log, run.from)
			if serr != nil {
				log.Error("读取唤醒日志失败", "err", serr)
				return
			}
			code := 0
			if err != nil {
				code = 1
			}
			again, reason, ferr := attempt.Finish(bg, seg, code, len(left) < len(p.IDs))
			retry = again && ferr == nil && len(left) > 0
			if ferr != nil {
				err = ferr
			} else if reason != "" {
				err = fmt.Errorf("%s", reason)
			}
		}
		h.mu.Lock()
		next, forward := Outcome(len(left), h.fails[p.Leader])
		h.fails[p.Leader] = next
		h.mu.Unlock()
		if retry && !forward {
			if rerr := h.record(bg, env, p, run, err, len(left), nil, nil); rerr != nil {
				log.Error("记唤醒记录失败", "err", rerr)
				return
			}
			attempt.Tried = append(attempt.Tried, run.profile)
			attempt.Finish = nil
			continue
		}
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
		return
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

// recordTaskWakes 给这批事件涉及的任务各记一条「被唤醒」经历：拆派从第一步起在 task show
// 与网页可见（t1066）。同一件任务的多条事件并成一条；没挂任务的事件不记。
func recordTaskWakes(ctx context.Context, db *store.DB, p Pending) error {
	rows, err := eventRows(ctx, db, p.IDs)
	if err != nil {
		return err
	}
	byTask := map[string][]string{}
	var order []string
	for _, e := range rows {
		if e.Task == "" {
			continue
		}
		if _, ok := byTask[e.Task]; !ok {
			order = append(order, e.Task)
		}
		byTask[e.Task] = append(byTask[e.Task], "#"+strconv.FormatInt(e.ID, 10))
	}
	return db.Tx(ctx, func(tx *sql.Tx) error {
		for _, task := range order {
			if err := ledger.Record(ctx, tx, task, WakeKind, p.Leader, "事件 "+strings.Join(byTask[task], "、")); err != nil {
				return err
			}
		}
		return nil
	})
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
// 转给秘书时另落一条 stuck 级上报（负责人自己接不住的卡住事实），免得转过去的普通回执被降为知会后把这个阻塞一起藏起来。
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
			// 负责人自己接不住，这是新的卡住事实：转给秘书时补一条 stuck 级要处理上报。
			// 转过去的普通回执会在 Retarget 里降为知会，别让它们把这个阻塞一起藏起来。
			if to == org.Secretary {
				if err := events.Emit(ctx, tx, events.Event{
					Kind: events.LeaderEscalate, Target: org.Secretary, Level: events.Act,
					Body: map[string]any{"from": leader, "kind": "stuck", "label": kindLabel("stuck"),
						"note": fmt.Sprintf("连续 %d 次没处理完，%d 条事件转来", MaxFails, len(ids))},
				}); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	return targets, total, nil
}
