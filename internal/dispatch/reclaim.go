package dispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/workers"
	"github.com/liu-zhengdong/atrium/internal/worktree"
)

const reclaimedKind = "worktree_reclaimed"

type reclaimItem struct {
	id               int64
	task, repo, body string
	launch, exit     string
	remoteRunning    bool
	remoteRun        int
}

// reclaim 与派活串行：先停执行者，再回收，最后才能重建并派活。启动也走这条扫描，不另写补清路径。
func (d *dispatcher) reclaim(ctx context.Context) error {
	if d.reclaimAfter == 0 {
		d.reclaimDeferred = false
	}
	items, err := d.reclaimBatch(ctx)
	if err != nil {
		return err
	}
	err = ledger.EachTask(ctx, d.env.DB, "dispatch.reclaim", items, func(it reclaimItem) string { return it.task }, func(it reclaimItem) error {
		if d.procOf(it.task) != nil {
			d.reclaimDeferred = true
			return nil
		}
		var w gates.Worktree
		if err := json.Unmarshal([]byte(it.body), &w); err != nil {
			return fmt.Errorf("%s 工作树登记无效：%w", it.task, err)
		}
		// 早期 worktree/launch 没有 host，彼时只在本机运行；不把缺字段误判为远程。
		if w.Host == "" {
			w.Host = LocalHost
		}
		if w.Dir == "" {
			return fmt.Errorf("%s 工作树登记缺目录，无法确认回收目标", it.task)
		}
		// 扫描后若被人工重开，pump 在回收之后重建；不会与新执行者并发删同一个目录。
		pending, err := d.reclaimPending(ctx, it)
		if err != nil {
			return err
		}
		if pending {
			d.reclaimDeferred = true
			return nil
		}
		if w.Remote() {
			if !hosts.Online(w.Host) {
				d.reclaimDeferred = true
				return nil
			}
			if err := hosts.Reclaim(ctx, w.Host, hosts.ReclaimRequest{Task: it.task, Dir: w.Dir, Run: it.remoteRun}); err != nil {
				return err
			}
		} else if filepath.IsAbs(w.Dir) && filepath.Clean(w.Dir) == filepath.Join(d.env.Paths.Data, "tasks", it.task, "repo") {
			clone := ""
			if it.repo != "" {
				var err error
				clone, _, err = RepoSource(d.env.Paths.Data, it.repo)
				if err != nil {
					return err
				}
			}
			if err := worktree.Remove(ctx, clone, w.Dir, Branch(it.task), run); err != nil {
				return err
			}
		} else {
			return fmt.Errorf("%s 登记目录不是本实例的任务仓库工作树，保留目录", it.task)
		}
		if err := ledger.Record(ctx, d.env.DB, it.task, reclaimedKind, actor, strconv.FormatInt(it.id, 10)); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(items) > 0 {
		d.reclaimAfter = items[len(items)-1].id
	}
	if len(items) < 100 {
		d.reclaimAfter = 0
	}
	return nil
}

// reclaimPending 等服务重启窗口里的执行者退出；远程仍按任务轮号接管并停下。
// 本机历史 PID 可能被复用，不能仅凭旧拉起记录结束一个当前进程。
func (d *dispatcher) reclaimPending(ctx context.Context, it reclaimItem) (bool, error) {
	if it.launch == "" {
		return false, nil
	}
	var r workers.Run
	if err := json.Unmarshal([]byte(it.launch), &r); err != nil {
		return false, err
	}
	if r.Host == "" {
		r.Host = LocalHost
	}
	var exit workers.Exit
	if it.exit != "" {
		if err := json.Unmarshal([]byte(it.exit), &exit); err != nil {
			return false, err
		}
	}
	if exit.N == r.N {
		return false, nil
	}
	if r.Host == LocalHost {
		return platform.Alive(r.PID), nil
	}
	if !it.remoteRunning {
		return false, nil
	}
	if r.Host != LocalHost && !hosts.Online(r.Host) {
		return true, nil
	}
	p := &proc{task: it.task, run: r, remote: r.Host != LocalHost, done: make(chan struct{}), stopFor: "gone"}
	d.adoptProc(p)
	d.kill(ctx, p)
	return true, nil
}

// reclaimBatch 按工作树经历 id 分页；运行与退出记录同一批查，不在回收循环里逐件查库。
func (d *dispatcher) reclaimBatch(ctx context.Context) ([]reclaimItem, error) {
	args := []any{d.reclaimAfter}
	var marks []string
	for _, status := range ledger.Statuses {
		if Reclaimable(status) {
			marks = append(marks, "?")
			args = append(args, status)
		}
	}
	rows, err := d.env.DB.QueryContext(ctx, `SELECT e.id, e.task, t.repo, e.body,
		COALESCE((SELECT body FROM task_events l WHERE l.task = e.task AND l.kind = 'launch' ORDER BY id DESC LIMIT 1), ''),
		COALESCE((SELECT body FROM task_events x WHERE x.task = e.task AND x.kind = 'exit' ORDER BY id DESC LIMIT 1), ''),
		EXISTS(SELECT 1 FROM host_runs h WHERE h.task = e.task AND h.exited_at IS NULL),
		COALESCE((SELECT run FROM host_runs h WHERE h.task = e.task), 0)
		FROM task_events e JOIN tasks t ON t.id = e.task
		WHERE e.id > ? AND e.kind = 'worktree' AND t.status IN (`+strings.Join(marks, ",")+`)
		AND NOT EXISTS (SELECT 1 FROM task_events c WHERE c.task = e.task AND c.kind = 'worktree_reclaimed' AND c.body = CAST(e.id AS TEXT))
		ORDER BY e.id LIMIT 100`, args...)
	if err != nil {
		return nil, err
	}
	var items []reclaimItem
	for rows.Next() {
		var it reclaimItem
		if err := rows.Scan(&it.id, &it.task, &it.repo, &it.body, &it.launch, &it.exit, &it.remoteRunning, &it.remoteRun); err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, it)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	return items, nil
}
