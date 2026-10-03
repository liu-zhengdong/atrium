package fakegh

import (
	"context"
	"errors"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/gates"
)

// Flaky 是一次性故障注入：前 fail 次 name 加首个子命令等于 script（如
// "gh repo"、"git push"）的调用按网络抖动的样子失败（cmd、stderr 照 gh/git
// 真实输出），之后原样放行。给重试测试制造临时错误，不依赖真实网络抖动；
// 计数只在返回的这只 Runner 上，不影响 g 本体。
func Flaky(g *GH, fail int, script, stderr string) gates.Runner {
	return &flaky{g: g, left: fail, script: script, stderr: stderr}
}

type flaky struct {
	g      *GH
	left   int    // 还要失败几次
	script string // 命中的调用："gh repo"、"git push" 这类
	stderr string
}

// Run 实现 gates.Runner：命中 script 且还有剩余次数就按 cmd + stderr 失败。
func (f *flaky) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	if f.left > 0 && len(args) > 0 && name+" "+args[0] == f.script {
		f.left--
		return "", &gates.CmdError{Cmd: name + " " + strings.Join(args, " "), Stderr: f.stderr, Err: errors.New("exit status 128")}
	}
	return f.g.Run(ctx, dir, name, args...)
}
