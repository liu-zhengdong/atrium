// Package leaders 是负责人的运行时：按事唤醒一次性负责人进程、签发与作废负责人令牌、
// 服务端按令牌判权限、上交。身份、备忘与投递对象（Recipient）在 org 包里；
// 本包单独成包是因为它要调 events 与 ledger，而 events 调 org（放在 org 里会成环）。
//
// 判定都在本文件（纯函数，表驱动测试）；IO 在 wake.go、guard.go、escalate.go。
package leaders

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
)

const (
	BatchDelay  = 30 * time.Second // 攒批：最早一条等满 30 秒才唤醒
	WakeTimeout = 20 * time.Minute // 单次唤醒上限
	MaxFails    = 2                // 连续失败几次就把没确认的事件转交上一层
	MaxBatch    = 50               // 一次唤醒最多带几条事件
	maxNote     = 2000
)

// Kinds 是上交的四类。
var Kinds = []struct{ Key, Label string }{
	{"shipped", "已上线（里程碑）"},
	{"cross", "需要别的部门配合"},
	{"beyond", "越过权限或底线"},
	{"stuck", "搞不定"},
}

func kindLabel(k string) string {
	for _, x := range Kinds {
		if x.Key == k {
			return x.Label
		}
	}
	return ""
}

// EscalateIn 是 leader escalate 的输入。
type EscalateIn struct {
	Kind  string `json:"kind"`
	Note  string `json:"note"`
	Task  string `json:"task,omitempty"`
	Event int64  `json:"event,omitempty"` // 转交下层上交给我的那一条
}

// CheckEscalate 纯校验上交输入。
func CheckEscalate(in EscalateIn) error {
	if kindLabel(in.Kind) == "" {
		keys := make([]string, len(Kinds))
		for i, k := range Kinds {
			keys[i] = k.Key + "（" + k.Label + "）"
		}
		return api.Usage("--kind: 只能是 %s", strings.Join(keys, "、"))
	}
	if strings.TrimSpace(in.Note) == "" {
		return api.Usage("<说明>: 不能为空：写清要上面做什么")
	}
	if n := utf8.RuneCountInString(in.Note); n > maxNote {
		return api.Usage("<说明>: 最多 %d 字，收到 %d 字", maxNote, n)
	}
	if in.Task != "" && !api.IsRef(in.Task, "t") {
		return api.Usage("--task: 应为 tN，收到 %q", in.Task)
	}
	if in.Kind == "shipped" && in.Task == "" && in.Event == 0 {
		return api.Usage("--task: 上交「已上线」要给上线的任务")
	}
	return nil
}

// Pending 是一位负责人手上没确认的事件。
type Pending struct {
	Leader string
	Oldest int64 // 最早一条的时间（毫秒）
	IDs    []int64
}

// Due 纯判定：哪些负责人该唤醒——最早一条已等满攒批时长，且这位没有在跑的唤醒。
func Due(pending []Pending, running map[string]bool, now int64, batch time.Duration) []Pending {
	var out []Pending
	for _, p := range pending {
		if !running[p.Leader] && len(p.IDs) > 0 && now-p.Oldest >= batch.Milliseconds() {
			out = append(out, p)
		}
	}
	return out
}

// Outcome 纯判定：一次唤醒结束后怎么收尾。left 是这批里仍没确认的条数。
// 全确认了算成功（清零失败次数）；否则失败次数 +1，到 MaxFails 就转交上一层并清零。
func Outcome(left, fails int) (next int, forward bool) {
	if left == 0 {
		return 0, false
	}
	if fails+1 >= MaxFails {
		return 0, true
	}
	return fails + 1, false
}

// PickWorker 纯函数：第 fails 次重试用组合里的第几个（轮换）；组合为空返回空串。
func PickWorker(workers []string, fails int) string {
	if len(workers) == 0 {
		return ""
	}
	return workers[fails%len(workers)]
}

// Upstream 纯判定：负责人 who 上交（或转交）投给谁。从 dept 往上找到 who 负责的那一层
// （dept 不在 who 的链上或没给时，用 who 负责的第一个部门），再往上找最近的另一位负责人；没有投秘书。
func Upstream(parents, leaders map[string]string, who, dept string) string {
	start := ""
	for cur, n := dept, 0; cur != "" && n <= org.MaxDepth; cur, n = parents[cur], n+1 {
		if leaders[cur] == who {
			start = cur
			break
		}
	}
	if start == "" {
		led := org.Led(leaders, who)
		if len(led) == 0 {
			return org.Secretary
		}
		start = led[0]
	}
	up, _ := org.Nearest(parents, leaders, start, who)
	return up
}

// Event 是提示词里的一条事件。
type Event struct {
	ID   int64  `json:"id"`
	At   int64  `json:"at"`
	Kind string `json:"kind"`
	Task string `json:"task,omitempty"`
	Dept string `json:"dept,omitempty"`
	Body string `json:"body,omitempty"`
}

// DeptBrief 是提示词里负责的一个部门：人话字段、路径、要点链、资料总览，
// 以及没登记负责人、因而也归你管的下属部门（org.Covered）。
type DeptBrief struct {
	Dept      org.Dept
	Path      []string
	Chain     []org.Point
	Materials string
	Covered   []org.Dept
}

// PromptInput 是一次唤醒提示词的全部材料。
type PromptInput struct {
	Leader   org.Identity
	Depts    []DeptBrief
	Memo     string
	Events   []Event
	Upstream string
}

// Prompt 纯函数：唤醒负责人的提示词。
func Prompt(in PromptInput) string {
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format+"\n", a...) }
	home := "oN"
	if len(in.Depts) > 0 {
		home = in.Depts[0].Dept.ID
	}
	w("你是 Atrium 组织里的负责人 %s（%s）。你是一次性进程：处理完下面这批事件、确认后退出。", in.Leader.ID, in.Leader.Name)
	w("你的连续性存在 Atrium（要点、任务备注、你的备忘），不靠这次的记忆。你不写代码、不改仓库：活派给执行者，你负责判断、派、盯、收。")
	w("")
	w("## 你负责的部门")
	if len(in.Depts) == 0 {
		w("（还没有部门指派给你）")
	}
	for _, d := range in.Depts {
		w("### %s %s（%s）", d.Dept.ID, d.Dept.Name, strings.Join(d.Path, " / "))
		for _, kv := range [][2]string{{"是什么", d.Dept.What}, {"怎么用", d.Dept.Uses}, {"现状", d.Dept.Now}, {"下一步", d.Dept.Next},
			{"仓库", strings.Join(d.Dept.Repos, "、")}} {
			if kv[1] != "" {
				w("%s：%s", kv[0], kv[1])
			}
		}
		if len(d.Chain) > 0 {
			w("要点（靠前的优先）：")
			for _, p := range d.Chain {
				w("- %s", org.ChainLine(p))
			}
			for _, o := range org.PointsOver(d.Chain) {
				w("- （%s）", o)
			}
		}
		if len(d.Covered) > 0 {
			subs := make([]string, len(d.Covered))
			for i, c := range d.Covered {
				subs[i] = c.ID + " " + c.Name
			}
			w("没登记负责人、也归你管的下属部门：%s", strings.Join(subs, "、"))
		}
		if d.Materials != "" {
			w("资料总览：")
			w("%s", d.Materials)
		}
	}
	w("")
	w("## 你的备忘（上次留给自己的，%s 字）", org.Tally("memo", utf8.RuneCountInString(in.Memo)))
	if in.Memo == "" {
		w("（空）")
	} else {
		w("%s", in.Memo)
	}
	w("")
	w("## 这批要处理的事件（%d 条）", len(in.Events))
	ids := make([]string, len(in.Events))
	for i, e := range in.Events {
		ids[i] = fmt.Sprint(e.ID)
		line := fmt.Sprintf("- #%d %s %s", e.ID, time.UnixMilli(e.At).Format("01-02 15:04"), e.Kind)
		if e.Task != "" {
			line += " " + e.Task
		}
		if e.Dept != "" {
			line += "（" + e.Dept + "）"
		}
		if e.Body != "" {
			line += " " + e.Body
		}
		w("%s", line)
	}
	w("")
	if slices.ContainsFunc(in.Events, func(e Event) bool { return e.Kind == events.TaskAssigned }) {
		w("## 交给你去拆的任务（task.assigned）")
		w("交来的是一件父任务，方案、拆活、派活、审核都归你：")
		w("1. 看它：task show tN；说明里没写清服务三个目标里的哪一个，先用 task note tN 补上。想清怎么做，取舍写进 task note。要用户拍板的整理成选项单（choice add），不要替用户定。")
		w("2. 拆成做得完的子任务：task add 标题 --parent tN --repo 仓库（或 --dir 本机文件夹）[--after tM]，先后用 --after 写清。长期方向写进部门介绍（org edit oN --next …），不建成做不完的任务。")
		w("3. 逐件 task run；依赖还没完成的也可以先 run，依赖完成后自动派，依赖失败或取消会转受阻并通知你。")
		w("4. 子任务的结果投给你，父任务进度由子任务汇总（task tree tN）；都完成后 task set tN --status done 收尾（子任务没结束时父任务不计时）。")
		w("正文带 tell 的是交给你之后的补充（捎话或改了说明），以它和 task show tN 的最新说明为准；没取走时合并成最新一条，之前的补充在 task show 的经历里。已按旧说明派出的子任务用 task tell / task set --detail 跟上，做偏了的 task stop。")
		w("")
	}
	w("## 可用命令（都是 atrium，已按你的身份连到服务；加 --json 得结构化结果）")
	w("- 看：task show tN；task log tN；task ls --org %s；org show oN", home)
	w("- 派与管：task add 标题 --org %s；task run tN；task tell tN 补充；task stop tN；task set tN --status …；task note tN 取舍与原因", home)
	w("- 验收（部门的验收人是负责人时，等验收的事件投给你）：task accept tN；task reject tN --reason 哪里不行")
	w("- 规矩写成要点：point add oN 一句话 --why 为什么；point edit kN …")
	w("- 记草稿：%s", ledger.DraftHowTo)
	w("- 资料：material ls 按部门列全部资料，material ls mN 取全文（二进制加 --out 文件），material add 加资料；跨部门的事先查别的部门已有的资料再调研，不直接搜数据目录")
	w("- 周期任务：schedule add/ls/rm/run")
	w("- 备忘：memo edit 文本（覆盖写，超过 %d 字会被拒，先精简）", org.MaxMemo)
	w("")
	w("## 权限边界（服务端按你的令牌强制，越权会被拒）")
	w("- 可以：动你负责的部门及其下属的任务、要点、资料、周期任务；改这些部门的介绍（org edit oN --what/--uses/--now/--next）；写自己的备忘；确认投给你的事件；上交。")
	w("- 不可以：动别的部门的东西、改部门本身（名称、负责人、上级、验收人、仓库、删除）、登记负责人、停机与服务操作。需要时上交。")
	w("")
	w("## 上交（投给 %s；只有这四类才上交，其余自己处理）", in.Upstream)
	for _, k := range Kinds {
		w("- %s %s → atrium leader escalate 说明 --kind %s [--task tN]", k.Key, k.Label, k.Key)
	}
	w("- 下层上交给你、你也要往上报的：atrium leader escalate 你的意见 --kind 同类 --event 编号（上面能看到原文），再确认原事件")
	w("")
	w("## 收尾")
	w("1. 要记住的（在等什么、下次先看什么）写进备忘；做了取舍的写进那件任务的备注。")
	w("2. 交付说明开头写了给人看的成品目录的，收尾时 material add oN 那个目录 --note 里面有什么、什么时候用，进部门资料。")
	w("3. 处理完确认：atrium events ack %s", strings.Join(ids, " "))
	w("4. 退出。没确认的事件会再次唤醒你；连续 %d 次没处理完，会转交 %s。", MaxFails, in.Upstream)
	return b.String()
}

// Rule 是负责人令牌碰到一个写接口时要查什么。
type Rule int

const (
	RuleDeny        Rule = iota // 不许
	RuleRead                    // 只读，放行
	RuleTaskRef                 // 路径 {id} 是任务：任务的部门在管辖内；请求体里的 org、parent 也要在
	RuleTaskCreate              // 建任务：请求体里的 org 或 parent 必须给且在管辖内
	RuleDeptRef                 // 路径 {id} 是部门（部门下的要点、资料、周期任务）
	RuleDeptIntro               // 改部门：路径 {id} 在管辖内，请求体只许介绍四项
	RulePointRef                // 路径 {id} 是要点
	RuleMaterialRef             // 路径 {id} 是资料
	RuleScheduleRef             // 路径 {id} 是周期任务
	RuleBodyDept                // 建资料、周期任务：请求体里的 org／department 必须给且在管辖内
	RuleMemo                    // 自己的备忘（由 memo 路由按身份判）
	RuleEventsAck               // 确认事件：只能是投给自己的
	RuleEscalate                // 上交
)

// RuleFor 纯判定：负责人令牌碰到这条路由（Go 路由模式，如 "POST /api/tasks/{id}/notes"）时的规则。默认拒绝。
func RuleFor(pattern string) Rule {
	method, path, _ := strings.Cut(pattern, " ")
	if !strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/api/service") || strings.HasPrefix(path, "/api/auth") {
		return RuleDeny
	}
	if method == "GET" || method == "HEAD" {
		return RuleRead
	}
	seg := strings.Split(strings.TrimPrefix(path, "/api/"), "/")
	switch {
	case path == "/api/tasks" && method == "POST":
		return RuleTaskCreate
	case seg[0] == "tasks" && len(seg) >= 2 && seg[1] == "{id}":
		return RuleTaskRef
	case path == "/api/org/{id}" && method == "PATCH":
		return RuleDeptIntro
	case seg[0] == "org" && len(seg) >= 3 && seg[1] == "{id}" && slices.Contains([]string{"points", "materials", "schedules"}, seg[2]):
		return RuleDeptRef
	case seg[0] == "points" && len(seg) >= 2 && seg[1] == "{id}":
		return RulePointRef
	case seg[0] == "materials" && len(seg) >= 2 && seg[1] == "{id}":
		return RuleMaterialRef
	case seg[0] == "materials" && len(seg) == 1:
		return RuleBodyDept
	case seg[0] == "schedules" && len(seg) >= 2 && seg[1] == "{id}":
		return RuleScheduleRef
	case seg[0] == "schedules" && len(seg) == 1:
		return RuleBodyDept
	case path == "/api/choices" && method == "POST": // 负责人给用户递选项单（拍板只有用户）
		return RuleBodyDept
	case path == "/api/memo" && method == "PUT":
		return RuleMemo
	case seg[0] == "events" && slices.Contains(seg, "ack"):
		return RuleEventsAck
	case path == "/api/escalations" && method == "POST":
		return RuleEscalate
	}
	return RuleDeny
}

// introFields 是负责人能改的部门字段：介绍四项。
var introFields = []string{"what", "uses", "now", "next"}

// IntroOnly 纯判定：改部门的请求体只含介绍四项才放行。按键名判，不看值：
// 解码时字段名不分大小写（"Leader" 也会落到 leader），所以键名必须和四项逐字相同。
func IntroOnly(body map[string]any) error {
	keys := slices.Sorted(maps.Keys(body))
	for _, k := range keys {
		if !slices.Contains(introFields, k) {
			return Forbid("负责人改部门只能改介绍（--what/--uses/--now/--next），%q 只归秘书和用户", k)
		}
	}
	return nil
}

// Check 是一项要落在管辖内的东西。Dept 为空表示它不属于任何部门（一律不在管辖内）。
type Check struct {
	What string
	Dept string
}

// InScope 纯判定：每项都在 scope 里才放行；否则返回给负责人看的中文说明（附上交提示）。
func InScope(leader string, scope map[string]bool, checks []Check) error {
	for _, c := range checks {
		if c.Dept == "" {
			return Forbid("%s 不属于任何部门，负责人 %s 动不了", c.What, leader)
		}
		if !scope[c.Dept] {
			return Forbid("%s 属于 %s，不在负责人 %s 管辖的部门里", c.What, c.Dept, leader)
		}
	}
	return nil
}

// Forbid 是越权：中文说明 + 上交提示。
func Forbid(format string, a ...any) *api.Error {
	return api.Forbidden(format+"；需要就上交", a...).WithNext("atrium leader escalate <说明> --kind beyond|cross")
}
