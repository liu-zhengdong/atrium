package dispatch

import (
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// PromptInput 是提示词的全部材料。
type PromptInput struct {
	Task    string
	Org     string // 任务所在部门：成品交进这个部门的资料；空表示不属于任何部门
	Title   string
	Detail  string
	Global  string   // 用户的全局原则（org.Principles 拼好的一节）；没有为空
	Points  []string // 部门要点链，每条一行（org.ChainLine）
	Skill   string   // 挂上的技能名
	Skills  string   // 其余技能的索引（org.SkillIndex 拼好的一节）；没有为空
	Profile string   // 执行者档案正文
	Bounces []string // 交回原因（最近的在后）
	Repo    string   // 仓库；空表示没有仓库
	Dir     string   // 工作地点（本机文件夹，原地干）；与 Repo 只有一个
	Origin  string   // 本机仓库 origin 的地址（gates.Origin；没有为空），和 Repo 一起定交付方式
	Branch  string
	Review  bool   // 审阅轮：提示词不附交付结论那条（gates.PromptRules）
	Guide   string // 目标仓库自己的约定（.agents/README.md 正文）；没有就空
}

// langRule 放在提示词开头（标题之后）与继续的补充里：排在末尾时执行者照样用英文写交付说明（t452）。
const langRule = "用中文写过程说明和最后的交付说明（命令、代码、标识符照原样）。"

// 通用约束：对所有仓库成立的，每件活都附；怎么交由交付方式定（gates.PromptRules）；
// 仓库自己的约定从目标仓库的 .agents/README.md 读（PromptInput.Guide）。
var commonRules = []string{
	"临时文件放 $TMPDIR，不写 /tmp；任务结束后临时目录会被回收。",
	"凭据不打印、不写进提交、PR、issue 或日志。",
	"不碰用户的真实环境：不启停用户在跑的服务，不读写用户主目录里的数据；要跑起来验证，就用临时数据目录与空闲端口起隔离实例，用完停掉。",
	"资料（在哪台机器上都能用 atrium 取）：atrium material ls 按部门列，atrium material ls mN 取正文、mN/<相对路径> 取这条资料里的其他文件（二进制加 --out 文件）；说明里给的 mN 就是给你的输入。跨部门的事先查再调研，不直接搜数据目录。",
	"只跑改动相关的快检查，不跑全量测试（全量由运行时跑）。",
}

// showRule 是给人看的产物怎么交（纯函数）：执行者自己交进任务所在部门的资料；任务不属于任何部门时交不了资料，写路径。
func showRule(dept string) string {
	const what = "给人看的产物（报告、页面、站点、视频、图）："
	if dept == "" {
		return what + "本任务不属于任何部门，交不了资料：成品放进一个单独目录（不提交进仓库），交付说明开头写这个目录的绝对路径和入口文件。"
	}
	return what + "把能直接打开的成品或截图放进一个只放它们的目录（不提交进仓库），做完 atrium material add " + dept +
		" <目录> --note <里面有什么、什么时候用> 交进部门资料（永远新建一条；改自己已交的那条写 material add mN <目录> 加一版），交付说明开头写资料号 mN 和入口文件。" +
		"网页资料预览只认相对路径：站点按相对路径构建（如 base 设成 ./），做不到就交截图。"
}

// BuildPrompt 拼提示词（纯函数）：标题 + 语言要求 + 详述 + 用户全局原则 + 部门要点链 + 挂上的技能 + 技能索引 + 执行者档案正文 + 仓库约定 + 交回原因 + 通用约束。
func BuildPrompt(in PromptInput) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# 任务 %s：%s\n\n%s\n", in.Task, in.Title, langRule)
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
	if in.Review {
		section("通用约束", commonRules)
		b.WriteString("\n本轮只读审阅：不修改文件、不提交、不推送、不评论、不合入；最后一行只写「审阅结论：通过」或「审阅结论：打回」。\n")
		return b.String()
	}
	if in.Global != "" {
		fmt.Fprintf(&b, "\n%s", in.Global)
	}
	section("部门要点（沿组织树继承，靠前的优先）", in.Points)
	if in.Skill != "" {
		fmt.Fprintf(&b, "\n## 技能\n\n按这份做法干：%s\n", strings.Replace(org.SkillHowTo, "<名字>", in.Skill, 1))
	}
	if in.Skills != "" {
		fmt.Fprintf(&b, "\n%s", in.Skills)
	}
	if p := strings.TrimSpace(in.Profile); p != "" {
		fmt.Fprintf(&b, "\n## 给这个执行者的叮嘱\n\n%s\n", p)
	}
	if g := strings.TrimSpace(in.Guide); g != "" {
		fmt.Fprintf(&b, "\n## 这个仓库的约定（.agents/README.md）\n\n%s\n", g)
	}
	section("上次交付被交回的原因（先解决这些）", in.Bounces)
	section("通用约束", append(append(gates.PromptRules(in.Repo, in.Dir, in.Origin, in.Branch, in.Detail, in.Review), commonRules...), showRule(in.Org)))
	return b.String()
}

// ResumePrompt 是按会话继续时的补充（只带没送到的补充说明）。
func ResumePrompt(tells []string) string {
	var b strings.Builder
	b.WriteString("补充（运行时转来的，后说的优先）：\n")
	for _, t := range tells {
		fmt.Fprintf(&b, "- %s\n", strings.TrimSpace(t))
	}
	b.WriteString("\n照补充调整，做完照原要求交付。" + langRule + "\n")
	return b.String()
}

// ExitInput 是执行者退出后判去向的输入。
type ExitInput struct {
	Code      int // workers.ExitUnknown 表示拿不到
	Signal    workers.Signal
	Ending    workers.Ending
	StopFor   string // 运行时停的：restart（带着补充说明重派）；空表示自己退出
	Same      int    // 这一轮已同一执行者重试几次
	Switches  int    // 这一轮已换过几次执行者
	Pending   int    // 没送到的补充说明
	CanResume bool   // 能按会话继续（取到了会话 id）
}

// Route 是去向。
type Route struct {
	Do     string // gate fail block same switch resume restart
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
	case workers.SignalQuota, workers.SignalSetup, workers.SignalModel, workers.SignalNoStart:
		if in.Switches < maxSwitches {
			return Route{"switch", s.Reason}
		}
		return Route{"block", s.Reason + "；已换过 " + itoa(in.Switches) + " 次执行者"}
	case workers.SignalThinking:
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
			return Route{"resume", "本轮结束，带着 " + itoa(in.Pending) + " 条补充继续会话"}
		}
		return Route{"restart", "本轮结束，带着 " + itoa(in.Pending) + " 条补充重派"}
	}
	return Route{"gate", "执行者正常退出"}
}
