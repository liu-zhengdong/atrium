package gates

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/platform"
)

// Runner 跑一条 git / gh 命令并返回标准输出。gates、merge、release 查事实与动仓库都经它；
// 测试换成假的（真 git + 假 gh）。
type Runner interface {
	Run(ctx context.Context, dir, name string, args ...string) (string, error)
}

// Exec 是真实的 Runner：经 platform 拉起，环境走服务白名单（gh 用自己登录的配置，不从环境拿令牌）。
type Exec struct{ Env map[string]string }

// NewExec 用当前进程环境（服务白名单）加非交互标记。
func NewExec() *Exec {
	env, _ := platform.ServiceEnv(runtime.GOOS, platform.EnvMap(os.Environ()))
	env["GH_PROMPT_DISABLED"] = "1"
	env["GIT_TERMINAL_PROMPT"] = "0"
	env["NO_COLOR"] = "1"
	env["GIT_PAGER"] = "cat"
	return &Exec{Env: env}
}

// CmdError 是命令非零退出：带标准错误的末尾，给人看、也原样交回执行者。
type CmdError struct {
	Cmd    string
	Stderr string
	Err    error
}

func (e *CmdError) Error() string {
	msg := strings.TrimSpace(e.Stderr)
	if len(msg) > 800 {
		msg = "…" + msg[len(msg)-800:]
	}
	return fmt.Sprintf("%s：%v：%s", e.Cmd, e.Err, msg)
}

func (e *CmdError) Unwrap() error { return e.Err }

func (x *Exec) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	path, err := platform.LookPath(name, x.Env)
	if err != nil {
		return "", err
	}
	var out, errb bytes.Buffer
	// Detached：超时时连子进程一起结束（pnpm 拉起的 node、浏览器的子进程还占着输出管道，只结束父进程 Wait 会一直等）。
	cmd, err := platform.Start(platform.Spec{Path: path, Args: args, Dir: dir, Env: x.Env, Stdout: &out, Stderr: &errb, Detached: true})
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
		return out.String(), &CmdError{Cmd: name + " " + strings.Join(firstN(args, 3), " "), Stderr: errb.String(), Err: err}
	}
	return out.String(), nil
}

// On 是在工作树所在机器上查事实的 Runner：本机就是 r；远程时带目录的 git 经那台的代理跑（hosts.Ask，代理只接只读子命令），
// gh 与不带目录的命令仍在服务这台跑（PR 与 CI 由服务查 GitHub）。
func On(r Runner, w Worktree) Runner {
	if !w.Remote() {
		return r
	}
	return remoteRunner{local: r, host: w.Host}
}

type remoteRunner struct {
	local Runner
	host  string
}

func (x remoteRunner) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	if name != "git" || dir == "" {
		return x.local.Run(ctx, dir, name, args...)
	}
	ack, err := hosts.Ask(ctx, x.host, hosts.Query{Dir: dir, Git: args})
	return ack.Output, err
}

// ReadFile 读工作树根下的一个文件（远程经代理读）；没有这个文件返回 nil。
func ReadFile(ctx context.Context, w Worktree, name string) ([]byte, error) {
	if w.Remote() {
		ack, err := hosts.Ask(ctx, w.Host, hosts.Query{Dir: w.Dir, File: name})
		if err != nil || ack.Missing {
			return nil, err
		}
		return []byte(ack.Output), nil
	}
	b, err := os.ReadFile(filepath.Join(w.Dir, name))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return b, err
}

func firstN[T any](s []T, n int) []T {
	if len(s) > n {
		return s[:n]
	}
	return s
}
