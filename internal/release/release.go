// Package release（桩，第二波实现）：上线：Atrium 自己的仓库合入后等发版，update + 平滑重启（调 service 的 /api/service/restart），只读冒烟通过记「已上线」。
//
// 命令（第二波）：update。
// 结果经 ledger.Apply(Released) 落账。
// 契约见 internal/README.md。
package release

import "github.com/liu-zhengdong/atrium/internal/app"

// Module 是本包接入点。第二波在这里填 Commands、Routes、Run；cmd/atrium 已把它排进模块列表。
func Module() app.Module { return app.Module{Name: "release"} }
