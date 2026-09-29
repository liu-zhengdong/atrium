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
	"github.com/liu-zhengdong/atrium/internal/platform"
)

// TaskDir 是任务目录：提示词、日志、工作树都在这里。
func TaskDir(data, task string) string { return filepath.Join(data, "tasks", task) }

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

// RemoteRepo 是派到远程时仓库的写法：本机克隆的绝对路径换成它 origin 的 owner/name（与关卡查 PR 同一个换算 gates.Slug），
// 其余原样。换算不了返回错误：这件活只派本机。
func RemoteRepo(ctx context.Context, repo string) (string, error) {
	if !filepath.IsAbs(repo) {
		return repo, nil
	}
	return gates.Slug(ctx, gates.NewExec(), repo)
}

// hostNeed 是这件活对机器的要求：仓库按远程的写法比对机器登记的仓库；本机克隆换算不出 origin 就只派本机。
func hostNeed(ctx context.Context, tool string, t ledger.Task) HostNeed {
	n := HostNeed{Tool: tool, Repo: t.Repo, Urgent: t.Priority == ledger.Urgent}
	if repo, err := RemoteRepo(ctx, t.Repo); err != nil {
		n.LocalOnly = fmt.Sprintf("仓库 %s 是本机克隆，换算不出 GitHub 上的 owner/name（%v）", t.Repo, err)
	} else {
		n.Repo = repo
	}
	return n
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

// Workdir 准备任务的工作目录：有仓库时在任务目录下建 git worktree（分支 task-tN，已有就沿用：交回原执行者接着改），
// 没有仓库用任务目录下的 work/。
func Workdir(ctx context.Context, data, task, repo string) (dir, branch string, err error) {
	td := TaskDir(data, task)
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
			return "", "", api.Conflict("工作树 %s 在分支 %s 上，不是 %s；先清掉再派", dir, cur, branch)
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
	if _, err := run(ctx, main, "git", "worktree", "add", "--quiet", "-B", branch, dir, base); err != nil {
		return "", "", err
	}
	return dir, branch, nil
}
