// Package hosts（桩，第二波实现）：机器：登记（本机 h1、远程 hN）、接入码换机器令牌、挑机器；远程代理（atrium agent）长轮询领活、续传日志、补报退出。
//
// 命令（第二波）：host add/ls/show/rm、agent install，以及隐藏的 agent 入口。
// 机器令牌认证：Routes 里 r.AddAuth(...) 返回 api.Actor{Kind: "host", ID: "hN"}。
// 契约见 internal/README.md。
package hosts

import "github.com/liu-zhengdong/atrium/internal/app"

// Module 是本包接入点。第二波在这里填 Commands、Routes、Run；cmd/atrium 已把它排进模块列表。
func Module() app.Module { return app.Module{Name: "hosts"} }
