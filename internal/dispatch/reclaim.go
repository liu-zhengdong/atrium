package dispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/app"
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
	workdir          string
	launch, exit     string
	remoteRunning    bool
	remoteRun        int
}

// reclaim 与分派任务串行：先停执行者，再回收，最后才能重建并分派任务。启动也走这条扫描，不另写补清路径。
func (d *dispatcher) reclaim(ctx context.Context) error {
	if d.reclaimAfter == 0 {
		d.reclaimDeferred = false
	}
	items, err := d.reclaimBatch(ctx)
	if err != nil {
		return err
	}
	err = ledger.EachTask(ctx, d.env.DB, "dispatch.reclaim", items, func(it reclaimItem) string { return it.task }, func(it reclaimItem) error {
		// 沿用 EachTask 的错误去重；回收只清理旧交付，不拥有当前任务的状态。
		// 单件错误在这里记经历，不能交给通用错误处理把重排后的任务转受阻。
		if err := d.reclaimOne(ctx, it); err != nil {
			if app.IsNotNow(err) {
				return err
			}
			if fatal := app.InfrastructureError(ctx, d.env.DB, err); fatal != nil {
				return fatal
			}
			return app.Global(ledger.Record(ctx, d.env.DB, it.task, ledger.KindLoopError, "dispatch.reclaim", fmt.Sprintf("dispatch.reclaim 出错：%v", err)))
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

func (d *dispatcher) reclaimOne(ctx context.Context, it reclaimItem) error {
	t, err := ledger.Get(ctx, d.env.DB, it.task)
	if err != nil {
		return err
	}
	if !Reclaimable(t.Status) {
		return nil
	}
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
	// 开始回收后才重排的，pump 仍在回收之后分派；远程另按轮号核对。
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
			if app.IsNotNow(err) {
				d.reclaimDeferred = true
				return nil
			}
			return err
		}
	} else if it.repo == "" && (w.Dir == filepath.Join(TaskDir(d.env.Paths.Data, it.task), "work") || (it.workdir != "" && w.Dir == it.workdir)) {
		// 指定工作地点与无仓库任务只回收临时文件，工作内容保留。
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
	if err := worktree.RemoveTemp(TempDir(d.env.Paths.Data, it.task)); err != nil {
		return err
	}
	if err := ledger.Record(ctx, d.env.DB, it.task, reclaimedKind, actor, strconv.FormatInt(it.id, 10)); err != nil {
		return err
	}
	return nil
}

// reclaimPending 等服务重启窗口里的执行者退出；远程仍按任务轮号继续跟进并停下。
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
	rows, err := d.env.DB.QueryContext(ctx, `SELECT e.id, e.task, t.repo, e.body, COALESCE((SELECT dir FROM task_dirs WHERE task = e.task), ''),
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
		if err := rows.Scan(&it.id, &it.task, &it.repo, &it.body, &it.workdir, &it.launch, &it.exit, &it.remoteRunning, &it.remoteRun); err != nil {
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
