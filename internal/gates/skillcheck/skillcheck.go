// Package skillcheck 是技能声明的交付检查：技能的 checks 写检查名，交付检查在本机的工作目录里按名字查表、
// 由运行时自己跑（不采信执行者交来的结果），截图、联系表等产物放进任务目录供负责人审。
// 每项的判定是纯函数（本包 *_test.go 表驱动）；跑命令经调用方给的 Runner，测试换成假的。
package skillcheck

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/platform"
)

// Runner 跑一条命令并返回标准输出（gates.Exec 满足它）；命令非零退出的错误要能 errors.As 出 *exec.ExitError。
type Runner interface {
	Run(ctx context.Context, dir, name string, args ...string) (string, error)
}

// Env 是一次检查的输入。
type Env struct {
	Dir     string                 // 工作目录（工作地点或工作树，本机）
	Out     string                 // 产物目录（任务目录）
	R       Runner                 // 跑 pnpm、ffmpeg、浏览器
	Browser func() (string, error) // 找无头浏览器；nil 用 FindBrowser
}

// Result 是一项检查的结论：没过时 Evidence 原样交回执行者；产物路径记进任务经历。
type Result struct {
	Check     string
	OK        bool
	Evidence  string
	Artifacts []string
}

// String 是记进任务经历的结论（产物路径另记）。
func (r Result) String() string {
	if r.OK {
		return r.Check + " 通过：" + r.Evidence
	}
	return r.Check + " 没过：" + r.Evidence
}

// check 跑一项检查：命令跑了但没过（非零退出、超时）写进 Result；跑不起来（缺工具、读写出错）返回错误，
// 那不是执行者能改的，由交付检查转受阻。
type check func(ctx context.Context, e Env) (Result, error)

// table 是检查名 → 实现。加一类产物就加一行。
var table = map[string]check{
	"article": article,
	"video":   video,
}

// Timeout 是每项检查的时限：交付检查一件一件推进，一项卡住不能堵住别的任务。
var Timeout = 5 * time.Minute

// Known 是全部检查名（排好序）。
func Known() []string {
	names := make([]string, 0, len(table))
	for n := range table {
		names = append(names, n)
	}
	slices.Sort(names)
	return names
}

// Validate 判一个检查名认不认识（技能保存时与交付检查跑之前都用它）。
func Validate(name string) error {
	if _, ok := table[name]; !ok {
		return fmt.Errorf("不认识的检查 %q（可用 %s）", name, strings.Join(Known(), "、"))
	}
	return nil
}

// Run 逐项跑，产物目录没有就建；名字不认识或某项跑不起来就返回错误。
func Run(ctx context.Context, e Env, names []string) ([]Result, error) {
	for _, n := range names {
		if err := Validate(n); err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(e.Out, 0o700); err != nil {
		return nil, err
	}
	var out []Result
	for _, n := range names {
		cctx, cancel := context.WithTimeout(ctx, Timeout)
		r, err := table[n](cctx, e)
		cancel()
		if err != nil {
			return nil, fmt.Errorf("检查 %s 跑不起来：%w", n, err)
		}
		r.Check = n
		out = append(out, r)
	}
	return out, nil
}

// failed 把命令出错分成两种：跑了没过（非零退出或超时）给出没过的原因；跑不起来原样返回错误。
func failed(ctx context.Context, what string, err error) (string, error) {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Sprintf("%s超时（每项 %s）", what, Timeout), nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return fmt.Sprintf("%s失败：%v", what, err), nil
	}
	return "", fmt.Errorf("%s：%w", what, err)
}

// FindBrowser 按 platform.Browsers 的顺序在服务环境里找无头浏览器。
func FindBrowser() (string, error) {
	env := platform.EnvMap(os.Environ())
	tried := platform.Browsers(runtime.GOOS)
	for _, b := range tried {
		if p, err := platform.LookPath(b, env); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("本机没找到无头浏览器（找过 %s）", strings.Join(tried, "、"))
}
