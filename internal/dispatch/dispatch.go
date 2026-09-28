// Package dispatch（桩，第二波实现）：派活：派活队列（queue 表）、挑执行者（档案能接 + 额度富余 + 不正忙）、挑机器（空位最多，本机优先）、在独立 git worktree 拉起执行者。
//
// 命令（第二波）：task run/stop/tell/log、top。
// 入队：ledger.Apply(Enqueue) 与写 queue 行在同一个事务；拉起后 ledger.Apply(Start)、ledger.SetFacts 记执行者与机器。
// 后台循环 Run：等 ledger.Changed() 或定时，每次取队首前先问 env.Pause.Paused(...)。
// 契约见 internal/README.md。
package dispatch

import "github.com/liu-zhengdong/atrium/internal/app"

// Module 是本包接入点。第二波在这里填 Commands、Routes、Run；cmd/atrium 已把它排进模块列表。
func Module() app.Module { return app.Module{Name: "dispatch"} }
