package watch

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Every 是巡检间隔。
var Every = time.Minute

// Run 是巡检循环：一分钟一轮；全局暂停时整轮不做，部门或机器暂停时跳过那些任务。
func Run(ctx context.Context, env *app.Env) error {
	t := time.NewTicker(Every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
		if err := Tick(ctx, env); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
	}
}

// ---- 进展（内存）：日志大小与工作树的最新修改时刻；服务重启后从头量 ----

type progress struct {
	pid   int
	log   int64
	stamp int64
	at    int64 // 最近一次有进展；0 表示拉起后还没有
	dead  int
	seen  bool
}

var mem = struct {
	sync.Mutex
	m map[string]*progress
}{m: map[string]*progress{}}

func progressOf(task string, pid int) int64 {
	mem.Lock()
	defer mem.Unlock()
	if p := mem.m[task]; p != nil && p.pid == pid {
		return p.at
	}
	return 0
}

// maxTreeEntries：量工作树时最多看这么多条，免得巨型仓库拖慢巡检。
const maxTreeEntries = 20000

// treeStamp 是工作树里（跳过 .git、node_modules）最新的修改时刻。
func treeStamp(dir string) int64 {
	if dir == "" {
		return 0
	}
	var latest int64
	n := 0
	filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && (d.Name() == ".git" || d.Name() == "node_modules") {
			return filepath.SkipDir
		}
		if n++; n > maxTreeEntries {
			return filepath.SkipAll
		}
		if info, err := d.Info(); err == nil && info.ModTime().UnixMilli() > latest {
			latest = info.ModTime().UnixMilli()
		}
		return nil
	})
	return latest
}

func fileSize(path string) int64 {
	if info, err := os.Stat(path); err == nil {
		return info.Size()
	}
	return 0
}

// observe 量一次进程：活没活、有没有进展。返回的 Obs 不含 Signal 与 StartStucks。
func observe(task string, p Proc, now int64) (Obs, int64) {
	alive := true
	if p.Local() {
		alive = platform.Alive(p.PID)
	}
	size, stamp := fileSize(p.Log), treeStamp(p.Dir)
	mem.Lock()
	defer mem.Unlock()
	cur := mem.m[task]
	if cur == nil || cur.pid != p.PID {
		cur = &progress{pid: p.PID, log: size, stamp: stamp}
		if size > 0 {
			cur.at = now // 第一次量就已有输出（多半是服务重启过）：从现在起算
		}
		mem.m[task] = cur
	} else if size != cur.log || stamp != cur.stamp {
		cur.log, cur.stamp, cur.at = size, stamp, now
	}
	cur.seen = true
	if alive {
		cur.dead = 0
	} else {
		cur.dead++
	}
	return Obs{Alive: alive, DeadTicks: cur.dead}, cur.at
}

// sweep 丢掉这一轮没见到的任务的进展记录。
func sweep() {
	mem.Lock()
	defer mem.Unlock()
	for k, p := range mem.m {
		if !p.seen {
			delete(mem.m, k)
		}
		p.seen = false
	}
}

// tail 读日志末尾至多 8KB。
func tail(path string) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	const n = 8 << 10
	if info, err := f.Stat(); err == nil && info.Size() > n {
		f.Seek(-n, io.SeekEnd)
	}
	b, _ := io.ReadAll(io.LimitReader(f, n))
	return b
}

// Tick 巡检一轮（测试直接调）。
func Tick(ctx context.Context, env *app.Env) error {
	entries, err := env.Pause.List(ctx)
	if err != nil {
		return err
	}
	active := make([]string, len(entries))
	for i, e := range entries {
		active[i] = e.Scope
	}
	if pause.Paused(active, pause.Scope{}) {
		return nil
	}
	if err := checkLimits(ctx, env); err != nil {
		return err
	}
	db := env.DB
	tasks, err := ledger.List(ctx, db, ledger.Filter{Status: []ledger.Status{ledger.Todo, ledger.Queued, ledger.Running,
		ledger.Blocked, ledger.Failed}, Limit: 500})
	if err != nil {
		return err
	}
	h := current()
	now := store.Now()
	for _, t := range tasks {
		if err := checkTask(ctx, env, active, h, t, now); err != nil {
			var ae *api.Error
			if errors.As(err, &ae) && ae.Code == "conflict" {
				// 拉起者同时在收尾（进程刚退出）：以账本为准，这一轮不动它。
				env.Log.Info("巡检跳过：任务状态已被别处改了", "task", t.ID, "err", err)
				continue
			}
			return fmt.Errorf("巡检 %s：%w", t.ID, err)
		}
	}
	sweep()
	return nil
}

func paused(ctx context.Context, q store.Querier, active []string, dept, host string) (bool, error) {
	s := pause.Scope{Host: host}
	if dept != "" {
		chain, err := org.Ancestors(ctx, q, dept)
		if err != nil {
			return false, err
		}
		s.Orgs = chain
	}
	return pause.Paused(active, s), nil
}

func checkTask(ctx context.Context, env *app.Env, active []string, hk Hooks, t ledger.Task, now int64) error {
	db := env.DB
	if stop, err := paused(ctx, db, active, t.Org, t.Host); err != nil || stop {
		return err
	}
	f, err := FactsOf(ctx, db, t)
	if err != nil {
		return err
	}
	var o Obs
	if f.Proc != nil {
		o, f.ProgressAt = observe(t.ID, *f.Proc, now)
		if f.Proc.Role == "worker" && hk.Signal != nil {
			o.Signal = hk.Signal(t.Worker, tail(f.Proc.Log))
		}
		if o.StartStucks, err = startStucks(ctx, db, t.ID); err != nil {
			return err
		}
	}
	h := HolderOf(f)
	act := Decide(h, o, now)
	if act == Keep {
		return nil
	}
	return perform(ctx, env, hk, t, f, h, o, act, now)
}

func perform(ctx context.Context, env *app.Env, hk Hooks, t ledger.Task, f Facts, h Holder, o Obs, act Action, now int64) error {
	db := env.DB
	exited := f.Proc != nil && !o.Alive
	signaled := f.Proc != nil && o.Alive && o.Signal.Retryable()
	due := !exited && !signaled && Level(h, now) > 0 // 真到期（而不是进程退出或读到信号）
	reason := string(act)
	switch {
	case exited:
		reason = "执行者进程已结束，没有拉起者收尾（服务重启过？）"
		if o.Signal != SigNone {
			reason += "；日志显示 " + string(o.Signal)
		}
	case signaled:
		reason = "执行者日志显示：" + string(o.Signal)
	case due:
		reason = fmt.Sprintf("%s，%s 没动", h.Text, Held(h.Since, now))
	}
	note := func() error {
		body, _ := json.Marshal(map[string]any{"role": h.Role, "action": act, "reason": reason, "signal": o.Signal})
		return ledger.Record(ctx, db, t.ID, "watch", "runtime", string(body))
	}
	kill := func() {
		if f.Proc != nil && f.Proc.Local() && o.Alive {
			if err := platform.KillTree(f.Proc.PID); err != nil {
				env.Log.Warn("结束进程树失败", "task", t.ID, "pid", f.Proc.PID, "err", err)
			}
		}
	}
	switch act {
	case ExitOK:
		_, err := ledger.Apply(ctx, db, t.ID, ledger.Event{Kind: ledger.ExitOK}, "runtime", reason)
		return err
	case ExitFail:
		_, err := ledger.Apply(ctx, db, t.ID, ledger.Event{Kind: ledger.ExitFail}, "runtime", reason)
		return err
	case Retry, Fail:
		if err := note(); err != nil {
			return err
		}
		if _, err := ledger.Apply(ctx, db, t.ID, ledger.Event{Kind: ledger.ExitFail}, "runtime", reason); err != nil {
			return err
		}
		kill()
		if act == Retry && hk.Requeue != nil {
			if err := hk.Requeue(ctx, t.ID, Why{Reason: reason, Signal: o.Signal, Worker: t.Worker}); err != nil {
				env.Log.Warn("重新入队失败", "task", t.ID, "err", err)
			}
		}
	case BlockIt:
		if err := note(); err != nil {
			return err
		}
		if _, err := ledger.Apply(ctx, db, t.ID, ledger.Event{Kind: ledger.Block}, "runtime", reason); err != nil {
			return err
		}
		kill()
	case KillIt:
		if err := note(); err != nil {
			return err
		}
		kill()
	}
	if !due {
		return nil
	}
	target := f.Owner
	if h.Who == "u1" { // 等你验收：经秘书提醒
		target = org.Secretary
	}
	if act == Escalate {
		up, err := upOf(ctx, db, t.Org)
		if err != nil || up == "" {
			return err
		}
		target = up
	}
	return overdue(ctx, db, target, t.ID, t.Org, h, Level(h, now), now, t.Title)
}

// overdue 发一条到期事件；同一次持球同一轮只发一回。
func overdue(ctx context.Context, db *store.DB, target, task, dept string, h Holder, lv int, now int64, title string) error {
	key := fmt.Sprintf("overdue:%s:%s:%s:%d:%d", task, h.Who, h.Role, h.Since, lv)
	seen, err := events.Seen(ctx, db, target, key)
	if err != nil || seen {
		return err
	}
	next := h.Next
	if next == "" && task != "" {
		next = "atrium task show " + task
	}
	body := map[string]any{"holder": h.Who, "role": h.Role, "held_ms": now - h.Since, "next": next, "text": h.Text}
	if title != "" {
		body["title"] = title
	}
	return db.Tx(ctx, func(tx *sql.Tx) error {
		return events.Emit(ctx, tx, events.Event{Kind: events.Overdue, Task: task, Dept: dept, Target: target, Key: key, Body: body})
	})
}
