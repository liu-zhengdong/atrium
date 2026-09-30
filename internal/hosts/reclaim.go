package hosts

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/worktree"
)

type ReclaimRequest struct {
	Task string `json:"task"`
	Dir  string `json:"dir"`
	Run  int    `json:"run"` // 回收时服务已知的最新远程轮号；旧指令不能删除重开后的新工作树
}

// Online 只对当前正在领指令的代理下发回收；离线的遗留记录留到下一轮扫描。
func Online(host string) bool { return theHub.isPolling(host) }

func Reclaim(ctx context.Context, host string, r ReclaimRequest) error {
	id, ackc := theHub.push(host, Command{Kind: "reclaim", Reclaim: &r})
	defer theHub.withdraw(host, id)
	select {
	case ack := <-ackc:
		if !ack.OK {
			return fmt.Errorf("%s 回收 %s 失败：%s", host, r.Task, ack.Error)
		}
		return nil
	case <-time.After(queryWait):
		return fmt.Errorf("%s 没回执回收 %s", host, r.Task)
	case <-ctx.Done():
		return ctx.Err()
	}
}

var reclaimTaskRE = regexp.MustCompile(`^t[1-9][0-9]*$`)

// ReclaimRefusal 只允许代理自己 repos/ 下、名字带本任务后缀的直接子目录。
func ReclaimRefusal(data string, r ReclaimRequest) string {
	if !reclaimTaskRE.MatchString(r.Task) {
		return "回收任务短号无效"
	}
	if !filepath.IsAbs(r.Dir) || filepath.Clean(r.Dir) != r.Dir || filepath.Dir(r.Dir) != filepath.Join(data, "repos") ||
		!strings.HasSuffix(filepath.Base(r.Dir), "-"+r.Task) || strings.TrimSuffix(filepath.Base(r.Dir), "-"+r.Task) == "" {
		return "回收目录不是代理为本任务创建的仓库工作树"
	}
	return ""
}

func (a *Agent) reclaim(ctx context.Context, r *ReclaimRequest) error {
	a.workspaceMu.Lock()
	defer a.workspaceMu.Unlock()
	if r == nil {
		return fmt.Errorf("回收指令缺内容")
	}
	if !reclaimTaskRE.MatchString(r.Task) {
		return fmt.Errorf("回收任务短号无效")
	}
	// 无仓库任务保留 work，但仍核对轮号与执行者退出后回收 tmp。
	workOnly := r.Dir == filepath.Join(a.Dir, "tasks", r.Task, "work")
	if why := ReclaimRefusal(a.Dir, *r); !workOnly && why != "" {
		return fmt.Errorf("%s", why)
	}
	// 已报退出的运行会从内存里移除；保留的 run-N.log 仍能证明重开已进入了新一轮。
	latest, err := a.reclaimGeneration(r.Task)
	if err != nil {
		return err
	}
	if latest > r.Run {
		return fmt.Errorf("%s 已进入第 %d 轮，拒绝第 %d 轮的旧回收指令", r.Task, latest, r.Run)
	}
	a.mu.Lock()
	st := a.runs[r.Task]
	if st != nil && (st.rec.Run > r.Run || !st.rec.Exited) {
		a.mu.Unlock()
		return fmt.Errorf("%s 的执行者还没退出或已进入更新的一轮", r.Task)
	}
	a.mu.Unlock()
	clone := strings.TrimSuffix(r.Dir, "-"+r.Task)
	if !workOnly {
		if err := worktree.Remove(ctx, clone, r.Dir, "task-"+r.Task, a.workspaceRun); err != nil {
			return err
		}
	}
	return worktree.RemoveTemp(filepath.Join(a.Dir, "tasks", r.Task, "tmp"))
}

func (a *Agent) reclaimGeneration(task string) (int, error) {
	entries, err := os.ReadDir(filepath.Join(a.Dir, "tasks", task))
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	latest := 0
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "run-") || !strings.HasSuffix(name, ".log") {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(name, "run-"), ".log"))
		if err == nil {
			latest = max(latest, n)
		}
	}
	return latest, nil
}

func (a *Agent) workspaceRun(ctx context.Context, dir, name string, args ...string) (string, error) {
	var out, stderr bytes.Buffer
	if err := a.runGit(ctx, dir, args, &out, &stderr); err != nil {
		return "", fmt.Errorf("git %v：%w：%s", args, err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

func (a *Agent) reclaimAndAck(ctx context.Context, c Command) {
	ack := Ack{ID: c.ID}
	if err := a.reclaim(ctx, c.Reclaim); err != nil {
		ack.Error = err.Error()
	} else {
		ack.OK = true
	}
	if err := a.call(ctx, "/api/agent/ack", ack, nil); err != nil {
		a.Log.Warn("回收回执没送到", "id", c.ID, "err", err)
	}
}
