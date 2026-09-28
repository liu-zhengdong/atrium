package dispatch

import (
	"context"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 本文件是派活用到的别的包的能力，集中在一处接线：hosts（挑机器、远程拉起）、quota（富余、额度用尽标记）、
// org（技能、凭据）。第二波并行开发时它们还没合入，先给只用本机、没有额度数据的缺省；合入后在这里换成真实调用。

// HostNeed 是一件活对机器的要求（同 hosts.Need）。
type HostNeed struct {
	Tool   string
	Repo   string
	Urgent bool
}

// HostChoice 是挑机器的结论（同 hosts.Choice）：run 在 Host 上拉起；queue 排队；refuse 拒绝。
type HostChoice struct {
	Kind   string `json:"kind"`
	Host   string `json:"host,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// Spare 是一个额度账号的富余（同 quota.Spare）。
type Spare struct {
	Known  bool    `json:"known"`
	Room   float64 `json:"room"`
	Held   bool    `json:"held"`
	Reason string  `json:"reason,omitempty"`
}

// Remote 是派到远程机器的一次运行（交给 hosts 的代理协议）。
type Remote struct {
	Task    string
	Tool    string
	Request workers.Request
	Repo    string
	Branch  string
	Env     map[string]string // 任务声明的凭据：名称 → 值
	Log     string            // 服务这台上的日志文件，代理按偏移续传到这里
}

// LocalHost 是本机的短号。
const LocalHost = "h1"

// localSlots 是本机同时跑几个执行者（hosts 接上后按机器登记的上限）。
const localSlots = 4

var (
	pickHost = func(ctx context.Context, env *app.Env, n HostNeed, pinned string) (HostChoice, error) {
		if pinned != "" && pinned != LocalHost {
			return HostChoice{Kind: "refuse", Reason: pinned + " 不能用：远程机器还没接入派活"}, nil
		}
		running, err := runningOn(ctx, env.DB, LocalHost)
		if err != nil {
			return HostChoice{}, err
		}
		if running >= localSlots && !n.Urgent {
			return HostChoice{Kind: "queue", Host: pinned, Reason: "本机已在跑 " + itoa(running) + " 个（上限 " + itoa(localSlots) + "）"}, nil
		}
		return HostChoice{Kind: "run", Host: LocalHost, Reason: "本机有空位"}, nil
	}
	// launchRemote 把运行交给远程代理，返回远程轮号与 pid；之后用 waitRemote 等它退出。
	launchRemote = func(ctx context.Context, env *app.Env, host string, r Remote) (run, pid int, err error) {
		return 0, 0, api.Conflict("%s 是远程机器，远程派活还没接上", host)
	}
	// waitRemote 等远程运行退出，返回退出码（不可得为 workers.ExitUnknown）。服务重启后照样能等。
	waitRemote = func(ctx context.Context, env *app.Env, task string, run int) (int, error) {
		return workers.ExitUnknown, api.Conflict("远程派活还没接上")
	}
	stopRemote = func(ctx context.Context, env *app.Env, task string) error {
		return api.Conflict("%s 在远程机器上跑，远程结束还没接上", task)
	}
	spares = func(ctx context.Context, env *app.Env) (map[string]Spare, error) { return map[string]Spare{}, nil }
	// accountOf 是工具对应的额度账号（同 quota.AccountOf）。
	accountOf = func(tool string) string {
		if tool == "agy" {
			return "antigravity"
		}
		return tool
	}
	// setHold 记额度用尽：到 until 之前派活避开这个账号。
	setHold = func(ctx context.Context, q store.Querier, account string, until int64, reason string) error {
		return nil
	}
	// skillOf 是任务挂的技能：SKILL.md 路径、优先执行者、要的凭据。
	skillOf = func(ctx context.Context, env *app.Env, name string) (Skill, error) {
		return Skill{}, api.Conflict("任务挂了技能 %s，但技能库还没接上", name)
	}
	// secretEnv 按名称从任务部门往上取凭据的值。
	secretEnv = func(ctx context.Context, env *app.Env, dept string, names []string) (map[string]string, error) {
		if len(names) == 0 {
			return map[string]string{}, nil
		}
		return nil, api.Conflict("任务要凭据，但凭据库还没接上")
	}
)

// Skill 是派活要的技能信息。
type Skill struct {
	Path    string
	Workers []string
	Secrets []string
}

func runningOn(ctx context.Context, q store.Querier, host string) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT count(*) FROM tasks WHERE status = 'running' AND stage = '' AND host = ?`, host).Scan(&n)
	return n, err
}
