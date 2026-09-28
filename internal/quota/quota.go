// Package quota（桩，第二波实现）：额度：自带读取 Claude Code、Codex、OpenCode 本机用量，其余走 OpenQuota；读数缓存在 quota_cache。
//
// 命令（第二波）：quota。dispatch 挑执行者时调本包判富余。
// 契约见 internal/README.md。
package quota

import "github.com/liu-zhengdong/atrium/internal/app"

// Module 是本包接入点。第二波在这里填 Commands、Routes、Run；cmd/atrium 已把它排进模块列表。
func Module() app.Module { return app.Module{Name: "quota"} }
