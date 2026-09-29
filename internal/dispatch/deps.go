package dispatch

import (
	"context"
	"slices"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 本文件是派活用到的别的包的能力，集中在一处：hosts（挑机器、远程拉起、等退出）、quota（富余、额度用尽标记）、
// org（技能、凭据）。都是变量，测试换成假的。

// HostNeed 是一件活对机器的要求。
type HostNeed = hosts.Need

// HostChoice 是挑机器的结论：run 在 Host 上拉起；queue 排队；refuse 拒绝。
type HostChoice = hosts.Choice

// Spare 是一个额度账号的富余。
type Spare = quota.Spare

// Remote 是派到远程机器的一次运行（交给 hosts 的代理协议）。
type Remote = hosts.Assignment

// LocalHost 是本机的短号。
const LocalHost = hosts.Local

var (
	pickHost = func(ctx context.Context, env *app.Env, n HostNeed, pinned string) (HostChoice, error) {
		return hosts.Pick(ctx, env, n, pinned)
	}
	// launchRemote 把运行交给远程代理，返回远程轮号、pid 与那台上的工作目录；之后用 waitRemote 等它退出。
	launchRemote = func(ctx context.Context, env *app.Env, host string, r Remote) (run, pid int, dir string, err error) {
		return hosts.Launch(ctx, env, host, r)
	}
	// waitRemote 等远程运行退出，返回退出码（不可得为 workers.ExitUnknown）。服务重启后照样能等。
	waitRemote = func(ctx context.Context, env *app.Env, task string, run int) (int, error) {
		x, err := hosts.WaitExit(ctx, env, task, run)
		if err != nil || x.Code == nil {
			return workers.ExitUnknown, err
		}
		return *x.Code, nil
	}
	stopRemote = hosts.Stop
	spares     = quota.Spares
	accountOf  = quota.AccountOf
	// setHold 记额度用尽：到 until 之前派活避开这个账号（通用命令行执行者没有额度账号，不记）。
	setHold = func(ctx context.Context, q store.Querier, account string, until int64, reason string) error {
		if !slices.Contains(quota.Accounts, account) {
			return nil
		}
		return quota.SetHold(ctx, q, account, until, reason)
	}
	// skillOf 是任务挂的技能：SKILL.md 路径、优先执行者、要的凭据。
	skillOf = func(ctx context.Context, env *app.Env, name string) (Skill, error) {
		k, err := org.GetSkill(ctx, env.DB, env.Paths.Data, name)
		return Skill{Path: k.Path, Workers: k.Workers, Secrets: k.Secrets}, err
	}
	// secretEnv 按名称从任务部门往上取凭据的值（记下使用时间）。
	secretEnv = func(ctx context.Context, env *app.Env, dept string, names []string) (map[string]string, error) {
		return org.SecretEnv(ctx, env.DB, env.Paths.Data, dept, names)
	}
)

// Skill 是派活要的技能信息。
type Skill struct {
	Path    string
	Workers []string
	Secrets []string
}

// adapterFor 给远程代理按工具名取适配器：内置的直接给；其余当通用命令行执行者（写法随请求的 CLI 带过去）。
func adapterFor(tool string) (workers.Adapter, bool) {
	if a, ok := workers.Builtin(tool); ok {
		return a, true
	}
	s, err := workers.ParseWorker(tool)
	return &workers.Driver{Tool: tool}, err == nil && s.Tool == tool
}
