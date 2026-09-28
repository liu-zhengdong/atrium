// Package merge（桩，第二波实现）：合入队列：串行 rebase → 快检查 → gh pr merge --squash --match-head-commit；冲突或没过交回原执行者；main 坏了回滚那次合入。
//
// 命令（第二波）：task merge。
// 结果经 ledger.Apply(Merged / Bounce) 落账。
// 契约见 internal/README.md。
package merge

import "github.com/liu-zhengdong/atrium/internal/app"

// Module 是本包接入点。第二波在这里填 Commands、Routes、Run；cmd/atrium 已把它排进模块列表。
func Module() app.Module { return app.Module{Name: "merge"} }
