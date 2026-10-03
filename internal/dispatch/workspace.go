package dispatch

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
	"github.com/liu-zhengdong/atrium/internal/worktree"
)

// TaskDir 是任务目录：提示词、日志、工作树都在这里。
func TaskDir(data, task string) string { return filepath.Join(data, "tasks", task) }

// TempDir 是任务的临时目录，也是本机执行者的会话临时目录（同一任务的各次运行先后共用）：
// 执行者退出后按它回收残留进程（服务重启后继续跟进时照样算得出），任务结束后随工作树回收。
func TempDir(data, task string) string { return filepath.Join(TaskDir(data, task), "tmp") }

// Branch 是任务的分支名。
func Branch(task string) string { return "task-" + task }

var (
	ownerNameRE = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)
	unsafeRE    = regexp.MustCompile(`[^\w.-]+`)
)

// RepoSource 判任务的仓库写法（纯函数）：绝对路径是本机已有的克隆；owner/name 与 URL 要先克隆到数据目录 repos/ 下。
func RepoSource(data, repo string) (local, cloneURL string, err error) {
	switch {
	case filepath.IsAbs(repo):
		return repo, "", nil
	case strings.Contains(repo, "://") || strings.HasPrefix(repo, "git@"):
		return filepath.Join(data, "repos", strings.Trim(unsafeRE.ReplaceAllString(repo, "_"), "_")), repo, nil
	case ownerNameRE.MatchString(repo) && !strings.Contains(repo, ".."):
		return filepath.Join(data, "repos", strings.ReplaceAll(repo, "/", "_")), "https://github.com/" + repo + ".git", nil
	}
	return "", "", api.Usage("任务的仓库 %q 看不懂：写 owner/name、克隆地址或本机克隆的绝对路径", repo)
}

// RemoteRepo 是派到远程时仓库的写法：本机克隆的绝对路径换成它 origin 的 owner/name（与交付检查查 PR 同一个换算 gates.Slug），
// 其余原样。换算不了返回错误：这件活只派本机。
func RemoteRepo(ctx context.Context, repo string) (string, error) {
	if !filepath.IsAbs(repo) {
		return repo, nil
	}
	return gates.Slug(ctx, gates.NewExec(), repo)
}

// hostNeed 是这件活对机器的要求：仓库按远程的写法比对机器登记的仓库；本机克隆换算不出 origin、有工作地点（本机文件夹）、
// 是体验巡检那样的定时任务一轮（agenda.LocalOnly）、档案端点是本机回环地址（Resolved.LocalOnly）就只派本机。
func hostNeed(ctx context.Context, q store.Querier, w workers.Spec, t ledger.Task) (HostNeed, error) {
	n := HostNeed{Tool: w.Tool, Model: w.Model, Repo: t.Repo, Urgent: t.Priority == ledger.Urgent}
	if t.Dir != "" {
		n.LocalOnly = "工作地点 " + t.Dir + " 是本机文件夹"
	} else if repo, err := RemoteRepo(ctx, t.Repo); err != nil {
		n.LocalOnly = fmt.Sprintf("仓库 %s 是本机克隆，换算不出 GitHub 上的 owner/name（%v）", t.Repo, err)
	} else {
		n.Repo = repo
	}
	if n.LocalOnly == "" {
		var err error
		if n.LocalOnly, err = agenda.LocalOnly(ctx, q, t.ID); err != nil {
			return HostNeed{}, err
		}
	}
	if n.LocalOnly == "" {
		r, err := workers.Resolve(ctx, q, w.String())
		if err != nil {
			return HostNeed{}, err
		}
		n.LocalOnly = r.LocalOnly()
	}
	return n, nil
}

// run 跑一条命令（经 platform），返回标准输出；失败时带上标准错误。
func run(ctx context.Context, dir, name string, args ...string) (string, error) {
	env := platform.EnvMap(os.Environ())
	env["GIT_TERMINAL_PROMPT"] = "0"
	path, err := platform.LookPath(name, env)
	if err != nil {
		return "", err
	}
	var out, errb bytes.Buffer
	cmd, err := platform.Start(platform.Spec{Path: path, Args: args, Dir: dir, Env: env, Stdout: &out, Stderr: &errb})
	if err != nil {
		return "", err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-ctx.Done():
		platform.KillTree(cmd.Process.Pid)
		<-done
		return "", ctx.Err()
	}
	if err != nil {
		return "", fmt.Errorf("%s %s：%v：%s", name, strings.Join(args, " "), err, strings.TrimSpace(errb.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

// Workdir 准备任务的工作目录：有仓库时在任务目录下建 git worktree（分支 task-tN，已有就沿用：交回原执行者接着改）；
// 有工作地点就是它本身（原地干，不复制、不建工作树）；都没有用任务目录下的 work/。
func Workdir(ctx context.Context, data, task, repo, place string) (dir, branch string, err error) {
	td := TaskDir(data, task)
	if place != "" {
		if fi, err := os.Stat(place); err != nil || !fi.IsDir() {
			return "", "", api.Conflict("工作地点 %s 不是已有的文件夹", place).WithNext("atrium task set " + task + " --dir <路径>")
		}
		return place, "", nil
	}
	if repo == "" {
		dir = filepath.Join(td, "work")
		return dir, "", os.MkdirAll(dir, 0o700)
	}
	main, url, err := RepoSource(data, repo)
	if err != nil {
		return "", "", err
	}
	branch, dir = Branch(task), filepath.Join(td, "repo")
	if _, err := os.Stat(dir); err == nil {
		cur, err := run(ctx, dir, "git", "rev-parse", "--abbrev-ref", "HEAD")
		if err != nil {
			return "", "", err
		}
		if cur != branch {
			return "", "", api.Conflict("任务 %s 的工作树 %s 在分支 %s 上，不是 %s；拉起前停止，由负责人核对分支归属；不要进入其他任务工作树或删除现有改动", task, dir, cur, branch)
		}
		return dir, branch, nil
	}
	if url != "" {
		if _, err := os.Stat(filepath.Join(main, ".git")); os.IsNotExist(err) {
			if err := os.MkdirAll(filepath.Dir(main), 0o700); err != nil {
				return "", "", err
			}
			if _, err := run(ctx, filepath.Dir(main), "git", "clone", "--quiet", url, main); err != nil {
				return "", "", err
			}
		}
	}
	base := "HEAD"
	if _, err := run(ctx, main, "git", "remote", "get-url", "origin"); err == nil {
		if _, err := run(ctx, main, "git", "fetch", "--quiet", "origin"); err != nil {
			return "", "", err
		}
		if head, err := run(ctx, main, "git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); err == nil {
			base = head
		} else if _, err := run(ctx, main, "git", "rev-parse", "--verify", "--quiet", "origin/main"); err == nil {
			base = "origin/main"
		}
	}
	if err := os.MkdirAll(td, 0o700); err != nil {
		return "", "", err
	}
	if err := worktree.Create(ctx, main, dir, branch, base, run); err != nil {
		return "", "", err
	}
	return dir, branch, nil
}
