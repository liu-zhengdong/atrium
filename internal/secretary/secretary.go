// Package secretary（桩，第二波实现）：秘书桥：atrium secretary bridge 把事件注入 Claude Code 会话，并向服务报「在听」。
//
// 命令（第二波）：secretary bridge、statusline。事件取用走 events 包。
// 契约见 internal/README.md。
package secretary

import "github.com/liu-zhengdong/atrium/internal/app"

// Module 是本包接入点。第二波在这里填 Commands、Routes、Run；cmd/atrium 已把它排进模块列表。
func Module() app.Module { return app.Module{Name: "secretary"} }
