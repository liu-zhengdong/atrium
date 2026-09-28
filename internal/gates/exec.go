package gates

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"runtime"
	"strings"

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

func (x *Exec) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	path, err := platform.LookPath(name, x.Env)
	if err != nil {
		return "", err
	}
	var out, errb bytes.Buffer
	cmd, err := platform.Start(platform.Spec{Path: path, Args: args, Dir: dir, Env: x.Env, Stdout: &out, Stderr: &errb})
	if err != nil {
		return "", err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-ctx.Done():
		cmd.Process.Kill()
		<-done
		return "", ctx.Err()
	}
	if err != nil {
		return out.String(), &CmdError{Cmd: name + " " + strings.Join(firstN(args, 3), " "), Stderr: errb.String(), Err: err}
	}
	return out.String(), nil
}

func firstN[T any](s []T, n int) []T {
	if len(s) > n {
		return s[:n]
	}
	return s
}
