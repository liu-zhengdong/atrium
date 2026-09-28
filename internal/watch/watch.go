// Package watch（桩，第二波实现）：持球与期限：一张表（持球人、期限、到期动作）、一个巡检循环、卡死判定；到期统一发 events.Overdue。
//
// 无命令；后台循环 Run。判定写纯函数：输入（持球人种类、最后进展时间、现在）→ 动作。
// 契约见 internal/README.md。
package watch

import "github.com/liu-zhengdong/atrium/internal/app"

// Module 是本包接入点。第二波在这里填 Commands、Routes、Run；cmd/atrium 已把它排进模块列表。
func Module() app.Module { return app.Module{Name: "watch"} }
