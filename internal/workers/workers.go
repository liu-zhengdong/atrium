// Package workers 是执行者：适配器（claude、codex、opencode、kimi、grok、agy、cursor、通用命令行）把
// 「工具 + 模型[:强度]」翻成进程调用（Launch，可序列化，远程代理也照它拉起）；档案（worker_profiles 表）
// 三层叠加 harness/<工具> ← models/<模型> ← combos/<工具>+<模型>，最具体的一层为准；
// 日志信号（额度用尽、供应商临时错误、思考耗尽、收尾）的判定是纯函数，dispatch 与 watch 共用。
//
// 命令：workers（列、看、改档案，按拉起统计）。拉起记录（Run）以任务经历 kind "launch" 存，gates、watch 用 LastRun 读；
// 每次拉起的结果（Exit）以 kind "exit" 存，Stats 按「工具+模型」数。
package workers

import (
	"github.com/liu-zhengdong/atrium/internal/app"
)

// Module 是本包接入点。
func Module() app.Module {
	return app.Module{Name: "workers", Commands: Commands, Routes: Routes}
}
