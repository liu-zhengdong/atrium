// Package workers（桩，第二波实现）：执行者适配器：claude、codex、opencode、kimi、grok、agy、cursor、通用命令行；把「工具 + 模型 + 强度」翻成进程调用。档案（worker_profiles 表，spec 为 YAML）三层叠加。
//
// 命令（第二波）：workers、workers edit。
// 契约见 internal/README.md。
package workers

import (
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/platform"
)

// Module 是本包接入点。第二波在这里填 Commands、Routes、Run；cmd/atrium 已把它排进模块列表。
func Module() app.Module { return app.Module{Name: "workers"} }

// Request 是一次拉起执行者需要的全部输入（dispatch 组装）。
type Request struct {
	Task   string // tN
	Prompt string // 标题 + 详述 + 要点链（org.Chain → org.ChainLine）+ 技能路径 + 通用约束
	Dir    string // 独立 worktree
	Model  string
	Effort string
}

// Adapter 把一次请求翻成进程调用（经 platform.Start 拉起），并从退出码与日志判出结果。
type Adapter interface {
	Name() string
	Spec(req Request, env map[string]string) (platform.Spec, error)
}
