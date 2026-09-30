package merge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Actor 是合入队列在经历里的署名。
const Actor = "merge"

// Item 是合入队列里的一件：按优先级（Rank 小先）、进队先后（经历 id 小先）排。
type Item struct {
	Task string
	Rank int
	At   int64
}

// Order 是队列顺序的唯一判定（纯函数）。
func Order(items []Item) []Item {
	out := append([]Item(nil), items...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Rank != out[j].Rank {
			return out[i].Rank < out[j].Rank
		}
		return out[i].At < out[j].At
	})
	return out
}

// Queue 串行合入：rebase 到最新默认分支 → 快检查 → gh pr merge --squash --match-head-commit。
// 队列本身就是账本里 stage=merge_queue 的任务，服务重启不丢。
type Queue struct {
	DB    *store.DB
	Pause *pause.Store
	R     gates.Runner
	Log   *slog.Logger
	Dir   string // 合入用的克隆与检查日志：<数据目录>/merge
	// NeedRelease 判合入后要不要等发版（Atrium 自己的仓库且本实例开了自升级）。
	NeedRelease func(repo string) bool
	// HeadWait 是推送 rebase 后等 GitHub 更新 PR 头提交的上限。
	HeadWait time.Duration
}

// Loop 等账本变化（或每 30 秒）把队列合空。
func (q *Queue) Loop(ctx context.Context) error {
	for {
		ch := ledger.Changed()
		if err := q.Drain(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ch:
		case <-time.After(30 * time.Second):
		}
	}
}

// Drain 一件一件合，直到队列里没有没暂停的任务。单件出错转受阻；库出错返回。
func (q *Queue) Drain(ctx context.Context) error {
	for {
		t, ok, err := q.next(ctx)
		if err != nil || !ok {
			return err
		}
		if err := ledger.EachTask(ctx, q.DB, "merge", []ledger.Task{t}, func(t ledger.Task) string { return t.ID }, func(t ledger.Task) error {
			return q.Merge(ctx, t)
		}); err != nil {
			return err
		}
	}
}

// next 取队首：没暂停的里优先级最高、最早进队的一件。
func (q *Queue) next(ctx context.Context) (ledger.Task, bool, error) {
	tasks, err := gates.InStage(ctx, q.DB, ledger.StageMerge)
	if err != nil {
		return ledger.Task{}, false, err
	}
	byID := map[string]ledger.Task{}
	var items []Item
	for _, t := range tasks {
		var at int64
		if err := q.DB.QueryRowContext(ctx, `SELECT COALESCE(max(id), 0) FROM task_events WHERE task = ? AND kind IN (?, ?, ?, ?)`,
			t.ID, ledger.GatePass, ledger.ReviewPass, ledger.Accept, ledger.Deliver).Scan(&at); err != nil {
			return ledger.Task{}, false, err
		}
		byID[t.ID] = t
		items = append(items, Item{Task: t.ID, Rank: t.Priority.Rank(), At: at})
	}
	for _, it := range Order(items) {
		t := byID[it.Task]
		ready := false
		err := ledger.EachTask(ctx, q.DB, "merge.pause", []ledger.Task{t}, func(t ledger.Task) string { return t.ID }, func(t ledger.Task) error {
			paused, err := gates.Paused(ctx, q.DB, q.Pause, t, "")
			ready = err == nil && !paused
			return err
		})
		if err != nil {
			return ledger.Task{}, false, err
		}
		if ready {
			return t, true, nil
		}
	}
	return ledger.Task{}, false, nil
}

func (q *Queue) note(ctx context.Context, id string, body map[string]any) error {
	raw, _ := json.Marshal(body)
	return ledger.Record(ctx, q.DB, id, gates.KindMerge, Actor, string(raw))
}

// Merge 合一件。冲突、检查没过交回原执行者；其余出错返回错误（调用方转受阻）。
func (q *Queue) Merge(ctx context.Context, t ledger.Task) error {
	if t.Repo == "" || t.PR == "" {
		return fmt.Errorf("任务没有仓库或 PR（repo=%q pr=%q）", t.Repo, t.PR)
	}
	repo, err := gates.Slug(ctx, q.R, t.Repo)
	if err != nil {
		return err
	}
	pr, err := gates.ViewPR(ctx, q.R, repo, t.PR)
	if err != nil {
		return err
	}
	switch pr.State {
	case "MERGED":
		return q.merged(ctx, t, repo, pr.URL, pr.MergeCommit, "PR 已在别处合入")
	case "OPEN":
	default:
		return fmt.Errorf("PR #%d 状态是 %s", pr.Number, pr.State)
	}
	dir, err := q.clone(ctx, repo)
	if err != nil {
		return err
	}
	git := func(args ...string) (string, error) {
		out, err := q.R.Run(ctx, dir, "git", args...)
		return strings.TrimSpace(out), err
	}
	if _, err := git("fetch", "--quiet", "origin",
		"+refs/heads/"+pr.Base+":refs/remotes/origin/"+pr.Base,
		"+refs/heads/"+pr.Head+":refs/remotes/origin/"+pr.Head); err != nil {
		return err
	}
	for _, args := range [][]string{{"reset", "--hard", "--quiet"}, {"clean", "-fdq"}, {"checkout", "--quiet", "--detach", pr.HeadID}} {
		if _, err := git(args...); err != nil {
			return err
		}
	}
	if _, err := git("-c", "user.name=Atrium", "-c", "user.email=atrium@localhost", "rebase", "--quiet", "origin/"+pr.Base); err != nil {
		conflicts, _ := git("diff", "--name-only", "--diff-filter=U")
		if _, aerr := git("rebase", "--abort"); aerr != nil {
			return aerr
		}
		if conflicts == "" {
			return err
		}
		files := strings.Split(conflicts, "\n")
		if err := q.note(ctx, t.ID, map[string]any{"conflict": files, "base": pr.Base}); err != nil {
			return err
		}
		_, err := gates.Bounce(ctx, q.DB, t.ID, Actor, fmt.Sprintf("合入冲突：rebase 到 origin/%s 时冲突（%s）；在工作树里 rebase 解决后推送",
			pr.Base, strings.Join(files, "、")))
		return err
	}
	check, err := runCheck(ctx, q.DB, dir, filepath.Join(q.Dir, "logs"), t.ID)
	if err != nil {
		return err
	}
	if check.Skipped {
		if err := q.note(ctx, t.ID, map[string]any{"check": "skipped", "why": "仓库没有 " + CheckScript}); err != nil {
			return err
		}
	}
	if !check.Pass {
		if err := q.note(ctx, t.ID, map[string]any{"check": "failed", "stalled": check.Stalled, "log": check.Log, "tail": check.Tail}); err != nil {
			return err
		}
		why := "快检查没过"
		if check.Stalled {
			why = "快检查两次都 10 分钟没输出被结束"
		}
		_, err := gates.Bounce(ctx, q.DB, t.ID, Actor, fmt.Sprintf("%s（rebase 到 origin/%s 后跑 %s）；输出末尾：\n%s", why, pr.Base, CheckScript, check.Tail))
		return err
	}
	head, err := git("rev-parse", "HEAD")
	if err != nil {
		return err
	}
	if head != pr.HeadID {
		if _, err := git("push", "--quiet", "--force-with-lease=refs/heads/"+pr.Head+":"+pr.HeadID, "origin", "HEAD:refs/heads/"+pr.Head); err != nil {
			return err
		}
		if err := q.waitHead(ctx, repo, t.PR, head); err != nil {
			return err
		}
	}
	if _, err := q.R.Run(ctx, "", "gh", "pr", "merge", fmt.Sprint(pr.Number), "-R", repo, "--squash", "--match-head-commit", head); err != nil {
		return err
	}
	after, err := gates.ViewPR(ctx, q.R, repo, t.PR)
	if err != nil {
		return err
	}
	if after.State != "MERGED" {
		return fmt.Errorf("gh pr merge 返回成功，但 PR #%d 状态是 %s", pr.Number, after.State)
	}
	return q.merged(ctx, t, repo, after.URL, after.MergeCommit, "已合入")
}

func (q *Queue) merged(ctx context.Context, t ledger.Task, repo, url, commit, note string) error {
	if err := q.cleanupWorktree(ctx, t); err != nil {
		return err
	}
	raw, _ := json.Marshal(map[string]string{"pr": url, "commit": commit})
	if err := ledger.Record(ctx, q.DB, t.ID, gates.KindMergeCommit, Actor, string(raw)); err != nil {
		return err
	}
	need := q.NeedRelease != nil && q.NeedRelease(repo)
	if need {
		note += "，等发版上线"
	}
	_, err := ledger.Apply(ctx, q.DB, t.ID, ledger.Event{Kind: ledger.Land, Land: ledger.StageMerged, Final: !need}, Actor, note+"（"+short(commit)+"）")
	return err
}

// CleanupWorktree 判登记的目录是否为这件任务在本机数据目录下的仓库工作树。
// 远程代理的（登记的机器不是本机）和手工登记的其他目录不由本机合入队列清理。
func CleanupWorktree(data, task, recorded string) bool {
	return recorded != "" && filepath.IsAbs(recorded) &&
		filepath.Clean(recorded) == filepath.Join(data, "tasks", task, "repo")
}

func (q *Queue) cleanupWorktree(ctx context.Context, t ledger.Task) error {
	w, found, err := gates.Workspace(ctx, q.DB, t.ID)
	if err != nil || !found || w.Remote() {
		return err
	}
	dir := w.Dir
	if !CleanupWorktree(filepath.Dir(q.Dir), t.ID, dir) {
		return nil
	}
	if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	common, err := q.R.Run(ctx, dir, "git", "rev-parse", "--git-common-dir")
	if err != nil {
		return err
	}
	common = strings.TrimSpace(common)
	if !filepath.IsAbs(common) {
		common = filepath.Join(dir, common)
	}
	// 在工作树外执行：Windows 上删不掉进程当前所在的目录。
	if _, err := q.R.Run(ctx, "", "git", "--git-dir", common, "worktree", "remove", dir); err != nil {
		return err
	}
	if _, err := q.R.Run(ctx, "", "git", "--git-dir", common, "branch", "-D", "task-"+t.ID); err != nil {
		return err
	}
	return nil
}

func short(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}

// waitHead 等 GitHub 看到推送后的头提交，免得 --match-head-commit 对不上。
func (q *Queue) waitHead(ctx context.Context, repo, ref, head string) error {
	limit := q.HeadWait
	if limit == 0 {
		limit = time.Minute
	}
	deadline := time.Now().Add(limit)
	for {
		pr, err := gates.ViewPR(ctx, q.R, repo, ref)
		if err != nil {
			return err
		}
		if pr.HeadID == head {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("推送后 %s 内 PR 头提交还是 %s，不是 %s", limit, short(pr.HeadID), short(head))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// clone 是合入用的克隆：<Dir>/repos/<owner>/<name>，没有就 gh repo clone。
func (q *Queue) clone(ctx context.Context, repo string) (string, error) {
	owner, name, ok := strings.Cut(repo, "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") || strings.Contains(repo, "..") {
		return "", fmt.Errorf("仓库应为 owner/name，收到 %q", repo)
	}
	dir := filepath.Join(q.Dir, "repos", owner, name)
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		return dir, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return "", err
	}
	if _, err := q.R.Run(ctx, "", "gh", "repo", "clone", repo, dir, "--", "--quiet"); err != nil {
		return "", err
	}
	return dir, nil
}
