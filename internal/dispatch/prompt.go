package dispatch

import (
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/workers"
)

// PromptInput 是提示词的全部材料。
type PromptInput struct {
	Task    string
	Title   string
	Detail  string
	Points  []string // 部门要点链，每条一行（org.ChainLine）
	Skill   string   // 技能 SKILL.md 路径
	Profile string   // 执行者档案正文
	Tells   []string // 运行中捎话（时间正序）
	Bounces []string // 交回原因（最近的在后）
	Repo    string   // 仓库；空表示没有仓库
	Branch  string
	Guide   string // 目标仓库自己的约定（.agents/README.md 正文）；没有就空
}

// 通用约束：对所有仓库成立的，每件活都附；仓库自己的约定从目标仓库的 .agents/README.md 读（PromptInput.Guide）。
var commonRules = []string{
	"凭据不打印、不写进提交、PR、issue 或日志。",
	"不碰用户的真实环境：不启停用户在跑的服务，不读写用户主目录里的数据；要跑起来验证，就用临时数据目录与空闲端口起隔离实例，用完停掉。",
	"只跑改动相关的快检查，不跑全量测试（全量由运行时跑）。",
	"过程说明与最后的总结用中文（命令、代码、标识符照原样）。",
}

var repoRules = []string{
	"只交 PR：在分支 %s 上提交、推送并开 PR；不要合入、不要改默认分支、不要发版。",
	"PR 正文写「端到端验证」一节：在隔离实例里跑了什么、输出摘要；会停服务、改机器状态的步骤标注「只在隔离环境」。",
}

// BuildPrompt 拼提示词（纯函数）：标题 + 详述 + 部门要点链 + 技能路径 + 执行者档案正文 + 仓库约定 + 捎话与交回原因 + 通用约束。
func BuildPrompt(in PromptInput) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# 任务 %s：%s\n", in.Task, in.Title)
	if d := strings.TrimSpace(in.Detail); d != "" {
		fmt.Fprintf(&b, "\n%s\n", d)
	}
	section := func(title string, lines []string) {
		if len(lines) == 0 {
			return
		}
		fmt.Fprintf(&b, "\n## %s\n\n", title)
		for _, l := range lines {
			fmt.Fprintf(&b, "- %s\n", strings.ReplaceAll(strings.TrimSpace(l), "\n", " "))
		}
	}
	section("部门要点（沿组织树继承，靠前的优先）", in.Points)
	if in.Skill != "" {
		fmt.Fprintf(&b, "\n## 技能\n\n按这份做法干：%s（附属文件在同一目录）\n", in.Skill)
	}
	if p := strings.TrimSpace(in.Profile); p != "" {
		fmt.Fprintf(&b, "\n## 给这个执行者的叮嘱\n\n%s\n", p)
	}
	if g := strings.TrimSpace(in.Guide); g != "" {
		fmt.Fprintf(&b, "\n## 这个仓库的约定（.agents/README.md）\n\n%s\n", g)
	}
	section("上次交付被交回的原因（先解决这些）", in.Bounces)
	section("运行中的补充（后说的优先）", in.Tells)
	rules := []string{}
	if in.Repo != "" {
		for _, r := range repoRules {
			rules = append(rules, strings.ReplaceAll(r, "%s", in.Branch))
		}
	} else {
		rules = append(rules, "这件活没有仓库：在当前目录干，交付物是最后一条消息里的结论（写清调查结果与依据）。")
	}
	section("通用约束", append(rules, commonRules...))
	return b.String()
}

// ResumePrompt 是按会话续上时的补充（只带没送到的捎话）。
func ResumePrompt(tells []string) string {
	var b strings.Builder
	b.WriteString("补充（运行时转来的，后说的优先）：\n")
	for _, t := range tells {
		fmt.Fprintf(&b, "- %s\n", strings.TrimSpace(t))
	}
	b.WriteString("\n照补充调整，做完照原要求交付。\n")
	return b.String()
}

// ExitInput 是执行者退出后判去向的输入。
type ExitInput struct {
	Code      int // workers.ExitUnknown 表示拿不到
	Signal    workers.Signal
	Ending    workers.Ending
	StopFor   string // 运行时停的：restart（带着捎话重派）；空表示自己退出
	Same      int    // 这一轮已同一执行者重试几次
	Switches  int    // 这一轮已换过几次执行者
	Pending   int    // 没送到的捎话
	CanResume bool   // 能按会话续上（取到了会话 id）
}

// Route 是去向。
type Route struct {
	Do     string // gate fail same switch resume restart
	Reason string
}

// 重试上限：同一执行者重试一次，换人两次。
const (
	maxSame     = 1
	maxSwitches = 2
)

// RouteExit 判执行者退出后的去向（纯函数）。
func RouteExit(in ExitInput) Route {
	if in.StopFor == "restart" {
		return Route{"restart", "带着补充重派"}
	}
	s := in.Signal
	switch s.Kind {
	case workers.SignalQuota, workers.SignalThinking:
		if in.Switches < maxSwitches {
			return Route{"switch", s.Reason}
		}
		return Route{"fail", s.Reason + "；已换过 " + itoa(in.Switches) + " 次执行者"}
	case workers.SignalTransient:
		if in.Same < maxSame {
			return Route{"same", s.Reason}
		}
		if in.Switches < maxSwitches {
			return Route{"switch", s.Reason + "；同一执行者已重试过"}
		}
		return Route{"fail", s.Reason + "；已重试并换过执行者"}
	}
	if in.Ending.Known && !in.Ending.OK {
		return Route{"fail", in.Ending.Reason}
	}
	if in.Code != 0 && in.Code != workers.ExitUnknown && !(in.Ending.Known && in.Ending.OK) {
		return Route{"fail", "执行者退出码 " + itoa(in.Code)}
	}
	if in.Pending > 0 {
		if in.CanResume {
			return Route{"resume", "本轮结束，带着 " + itoa(in.Pending) + " 条补充续上会话"}
		}
		return Route{"restart", "本轮结束，带着 " + itoa(in.Pending) + " 条补充重派"}
	}
	return Route{"gate", "执行者正常退出"}
}
