package watch

import (
	"fmt"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
)

// Role 是期限表里的一行：按当前在等谁、从什么时候起算。
type Role string

const (
	RoleWorkerStart Role = "worker_start" // 执行者启动后还没有任何进展
	RoleWorker      Role = "worker"       // 执行者有过进展后又停住
	RoleCheck       Role = "check"        // 合入前的快检查
	RoleRelease     Role = "release"      // 已合入等发版
	RoleAccept      Role = "accept"       // 等验收人（部门设置的 leader 或 user）
	RoleLeader      Role = "leader"       // 负责人（受阻、失败、待分派、积压事件）
	RoleSecretary   Role = "secretary"    // 秘书的事件没人取
)

// Rule 是期限表的一行。
type Rule struct {
	Role   Role          `json:"role"`
	Holder string        `json:"holder"`
	Limit  time.Duration `json:"limit"`
	Action string        `json:"action"`
}

// Rules 是等待对象与处理时限的唯一一张表（对应规格中的任务处理时限）。
var Rules = []Rule{
	{RoleWorkerStart, "执行者（启动）", 3 * time.Minute, "结束、重试一次，再卡转失败"},
	{RoleWorker, "执行者", 20 * time.Minute, "结束，转受阻交负责人"},
	{RoleCheck, "检查", 10 * time.Minute, "结束；有失败用例交回，没有按没跑成重跑一次（合入队列判）"},
	{RoleRelease, "发版", 30 * time.Minute, "告诉负责人"},
	{RoleAccept, "验收人", 24 * time.Hour, "提醒验收人一次，不向上级上报"},
	{RoleLeader, "负责人", 30 * time.Minute, "唤醒一次，再 30 分钟向上一级上报"},
	{RoleSecretary, "秘书", 3 * time.Minute, "状态栏标红"},
}

// Limit 查表：某一行的时限。
func Limit(r Role) time.Duration {
	for _, rule := range Rules {
		if rule.Role == r {
			return rule.Limit
		}
	}
	return 0
}

// Proc 是一个在跑的进程（执行者或检查），由拉起它的包用 Track 登记。
type Proc struct {
	Role string `json:"role"` // worker | check
	PID  int    `json:"pid"`
	Host string `json:"host,omitempty"` // 空或 h1 是本机
	Log  string `json:"log"`            // 服务这台机器上的日志文件（远程的由代理续传到这里）
	Dir  string `json:"dir,omitempty"`  // 工作树；看它有没有变化
	At   int64  `json:"at"`             // 拉起时刻
}

// Local 判断进程是否在服务这台机器上（能直接查存活、结束进程树）。
func (p Proc) Local() bool { return p.Host == "" || p.Host == "h1" }

// Holder 是「当前在等谁」。Role 为空表示不算期限（排队、等依赖、运行时自己推进）。
type Holder struct {
	Kind  string `json:"kind"` // worker check runtime release leader secretary user deps children draft
	Who   string `json:"who,omitempty"`
	Text  string `json:"text"`
	Short string `json:"short,omitempty"` // 列表行尾的短标签（网页）
	Role  Role   `json:"role,omitempty"`
	Since int64  `json:"since,omitempty"`
	Next  string `json:"next,omitempty"`
}

// Facts 是判定当前等待对象需要的事实，由调用方从账本、组织、内存里取来。
type Facts struct {
	Task         ledger.Task
	Owner        string            // 所属部门往上最近的负责人，没有是 secretary
	Acceptor     string            // 等验收时部门的验收人（org.AcceptLeader、org.AcceptUser）；别的阶段不取
	Deps         []ledger.DepState // 依赖（待派、排队的任务才取）
	DepEnded     map[string]int64  // 已结束的依赖各自结束的时刻（待派的任务才取）
	OpenChildren int               // 没结束的子任务（待派的任务才取）
	Children     int               // 全部子任务（待派的任务才取）
	ChildEnded   int64             // 子任务里最晚结束的时刻（待派且子任务都结束了才取）
	Proc         *Proc             // 与当前阶段对应的在跑进程；没有为 nil
	ProgressAt   int64             // 进程最近一次有进展；0 表示拉起后还没有
}

// HolderOf 判定一件没结束的任务当前在等谁，顺带给列表行尾的短标签。top、statusline、task show、网页共用。
func HolderOf(f Facts) Holder {
	t := f.Task
	owner := Holder{Kind: kindOf(f.Owner), Who: f.Owner, Role: RoleLeader, Since: t.UpdatedAt}
	waiting, broken := ledger.DepGate(f.Deps)
	switch t.Status {
	case ledger.Done, ledger.Cancelled:
		return Holder{Kind: "", Text: "已结束"}
	case ledger.Draft:
		// 草稿没有当前等待对象：不计时、不唤醒，想清楚了由人转待派。
		return Holder{Kind: "draft", Text: "草稿：还没想清楚，不分派任务、不计时", Next: "atrium task set " + t.ID + " --status todo"}
	case ledger.Todo:
		owner.Since = leaderSince(f, broken)
		if len(broken) > 0 {
			// 依赖等不到了：不会自己好，归负责人计时，改依赖或取消（不自动改写依赖）。
			var keep []string
			for _, d := range f.Deps {
				if d.Status != ledger.Failed && d.Status != ledger.Cancelled {
					keep = append(keep, d.ID)
				}
			}
			after := `""`
			if len(keep) > 0 {
				after = strings.Join(keep, ",")
			}
			owner.Text = "依赖的 " + ledger.BrokenText(broken) + "，改依赖或取消"
			owner.Short = "依赖的 " + ledger.BrokenText(broken)
			if len(broken) > 1 {
				owner.Short = fmt.Sprintf("%d 件依赖等不到了", len(broken))
			}
			owner.Next = "atrium task set " + t.ID + " --after " + after
			return owner
		}
		if len(waiting) > 0 {
			return Holder{Kind: "deps", Text: "等 " + strings.Join(waiting, "、") + " 完成", Short: waitShort(waiting)}
		}
		if f.OpenChildren > 0 {
			// 拆开在做的父任务：子任务各自计时，全部结束后负责人收到结果再来收尾。
			ended := fmt.Sprintf("%d/%d 结束", f.Children-f.OpenChildren, f.Children)
			return Holder{Kind: "children", Text: "子任务在做（" + ended + "）", Short: "子任务 " + ended}
		}
		owner.Text, owner.Short, owner.Next = "待分派", "没派", "atrium task run "+t.ID
		if f.Children > 0 {
			owner.Text, owner.Short, owner.Next = "子任务都结束了，等收尾", "等收尾", "atrium task set "+t.ID+" --status done"
		}
		return owner
	case ledger.Queued:
		if len(waiting) > 0 {
			return Holder{Kind: "deps", Text: "排队，等 " + strings.Join(waiting, "、") + " 完成后自动派", Short: waitShort(waiting)}
		}
		return Holder{Kind: "runtime", Who: "运行时", Text: "排队等执行者", Short: "排队"}
	case ledger.Blocked:
		owner.Text, owner.Short, owner.Next = "卡住，等处理", "卡住", "atrium task show "+t.ID
		return owner
	case ledger.Failed:
		owner.Text, owner.Short, owner.Next = "失败，等处理", "失败", "atrium task show "+t.ID
		return owner
	}
	// running：按交付阶段。
	switch t.Stage {
	case ledger.StageNone:
		h := Holder{Kind: "worker", Who: t.Worker, Text: "执行者在做"}
		h.Short, _, _ = strings.Cut(t.Worker, "+") // 短标签只放工具名与机器，完整组合在详情里
		if t.Host != "" {
			h.Text += "（" + t.Host + "）"
			if h.Short != "" {
				h.Short += " · "
			}
			h.Short += t.Host
		}
		if h.Short == "" {
			h.Short = "在做"
		}
		if f.Proc != nil {
			h.Role, h.Since = RoleWorkerStart, f.Proc.At
			if f.ProgressAt > 0 {
				h.Role, h.Since = RoleWorker, f.ProgressAt
			}
		}
		return h
	case ledger.StageGate:
		return Holder{Kind: "runtime", Who: "运行时", Text: "正在检查交付结果", Short: "验收中"}
	case ledger.StageReview:
		return Holder{Kind: "runtime", Who: "运行时", Text: "审阅中", Short: "审阅中"}
	case ledger.StageAccept:
		next := "atrium task accept " + t.ID
		if f.Acceptor == org.AcceptUser {
			return Holder{Kind: "user", Who: "u1", Text: "等你验收", Short: "等验收", Role: RoleAccept, Since: t.UpdatedAt, Next: next}
		}
		owner.Text, owner.Short, owner.Role, owner.Next = "等负责人验收", "等验收", RoleAccept, next
		return owner
	case ledger.StageMerge:
		if f.Proc != nil && f.Proc.Role == "check" {
			since := f.Proc.At
			if f.ProgressAt > 0 {
				since = f.ProgressAt
			}
			return Holder{Kind: "check", Who: "运行时", Text: "快检查在跑", Short: "合入队列", Role: RoleCheck, Since: since}
		}
		return Holder{Kind: "runtime", Who: "运行时", Text: "排队合入", Short: "合入队列"}
	case ledger.StageMerged:
		return Holder{Kind: "release", Who: "运行时", Text: "已合入，等发版", Short: "等发版", Role: RoleRelease, Since: t.UpdatedAt,
			Next: "atrium update"}
	}
	return Holder{Kind: "runtime", Who: "运行时", Text: string(t.Status) + "/" + string(t.Stage), Short: string(t.Stage)}
}

// waitShort 是等依赖的短标签：两个短号还放得下；再多写件数，详情里看是哪几件。
func waitShort(waiting []string) string {
	if len(waiting) <= 2 {
		return "等 " + strings.Join(waiting, "、")
	}
	return fmt.Sprintf("等 %d 件", len(waiting))
}

// leaderSince 是待派任务归负责人时的计时起点：它开始要负责人处理的那一刻。依赖断了从最早断的那个算，
// 待分派、等收尾从最后一个结束的依赖或子任务算；都早于任务自己最近的改动时按改动时刻算。
// 只按任务的 updated_at 算的话，久放的待派任务依赖一断就已过两倍时限，负责人还没被唤醒就上报了。
func leaderSince(f Facts, broken []ledger.DepState) int64 {
	var at int64
	if len(broken) > 0 {
		for _, d := range broken {
			if e := f.DepEnded[d.ID]; e > 0 && (at == 0 || e < at) {
				at = e
			}
		}
	} else {
		for _, e := range f.DepEnded {
			at = max(at, e)
		}
		at = max(at, f.ChildEnded)
	}
	return max(f.Task.UpdatedAt, at)
}

// kindOf：aN 是负责人，其余（secretary）归秘书。
func kindOf(who string) string {
	if strings.HasPrefix(who, "a") {
		return "leader"
	}
	return "secretary"
}

// Level 是到期几轮：0 没到期；1 到期；2 过了两倍时限（负责人这一行据此再向上一级上报）。
func Level(h Holder, now int64) int {
	limit := Limit(h.Role)
	if limit == 0 || h.Since == 0 {
		return 0
	}
	held := time.Duration(now-h.Since) * time.Millisecond
	switch {
	case held >= 2*limit:
		return 2
	case held >= limit:
		return 1
	}
	return 0
}

// Signal 是从执行者日志尾部读出的信号（判定由 workers 提供，见 Hooks.Signal）。
type Signal string

const (
	SigNone      Signal = ""
	SigTransient Signal = "transient" // 供应商临时错误：重试或换人
	SigThinking  Signal = "thinking"  // 思考耗尽：换人
	SigQuota     Signal = "quota"     // 额度用尽：标记账号、换人
	SigError     Signal = "error"     // 执行者报错退出
	SigDone      Signal = "done"      // 执行者正常收尾
)

// Retryable：这类信号换人或重试就可能过去。
func (s Signal) Retryable() bool { return s == SigTransient || s == SigThinking || s == SigQuota }

// Obs 是巡检一轮对一个进程的观察。
type Obs struct {
	Alive       bool
	DeadTicks   int    // 连续几轮看到进程不在（拉起它的包会在进程退出时自己收尾；连续两轮不在说明没人收尾，如服务重启过）
	Signal      Signal // 日志尾部读出的信号
	StartStucks int    // 这件任务已因启动卡住重试过几次
}

// Action 是巡检对一件任务要做的事。
type Action string

const (
	Keep     Action = ""
	ExitOK   Action = "exit_ok"   // 进程已结束且没见错误：进入交付检查（交付检查自己查事实）
	ExitFail Action = "exit_fail" // 进程已结束且出错：转失败
	Retry    Action = "retry"     // 结束进程、转失败、交给分派任务重新入队（可换人）
	Fail     Action = "fail"      // 结束进程、转失败
	BlockIt  Action = "block"     // 结束进程、转受阻交负责人
	KillIt   Action = "kill"      // 结束检查进程（结果由合入队列判）
	Notify   Action = "notify"    // 发 overdue 给当前等待对象（负责人一轮）
	Escalate Action = "escalate"  // 发 overdue 给上一层
)

// Decide 是巡检的判定：纯函数。
func Decide(h Holder, o Obs, now int64) Action {
	if h.Kind == "worker" && h.Role != "" { // 有登记进程的执行者
		if !o.Alive {
			if o.DeadTicks < 2 {
				return Keep
			}
			switch {
			case o.Signal.Retryable():
				return Retry
			case o.Signal == SigError:
				return ExitFail
			}
			return ExitOK
		}
		if o.Signal.Retryable() {
			return Retry
		}
	}
	lv := Level(h, now)
	if lv == 0 {
		return Keep
	}
	switch h.Role {
	case RoleWorkerStart:
		if o.StartStucks == 0 {
			return Retry
		}
		return Fail
	case RoleWorker:
		return BlockIt
	case RoleCheck:
		if o.Alive {
			return KillIt
		}
		return Keep
	case RoleRelease:
		return Notify
	case RoleAccept:
		if lv == 1 { // 只提醒一次：验收人已是这件事的最上层
			return Notify
		}
	case RoleLeader:
		if lv == 2 {
			return Escalate
		}
		return Notify
	}
	return Keep
}

// Held 是一句「等了多久」的人话。
func Held(since, now int64) string {
	if since == 0 {
		return ""
	}
	m := (now - since) / 60000
	switch {
	case m < 1:
		return "不到 1 分钟"
	case m < 60:
		return fmt.Sprintf("%d 分钟", m)
	}
	return fmt.Sprintf("%d 小时 %d 分", m/60, m%60)
}
