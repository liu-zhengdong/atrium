package ledger

import "fmt"

// Status 是任务状态。
type Status string

const (
	Todo      Status = "todo"
	Queued    Status = "queued"
	Running   Status = "running"
	Done      Status = "done"
	Failed    Status = "failed"
	Blocked   Status = "blocked"
	Cancelled Status = "cancelled"
)

var Statuses = []Status{Todo, Queued, Running, Done, Failed, Blocked, Cancelled}

func (s Status) Valid() bool {
	for _, v := range Statuses {
		if s == v {
			return true
		}
	}
	return false
}

// Finished：进入这些状态记结束时间，不再自己动。
func (s Status) Finished() bool { return s == Done || s == Failed || s == Cancelled }

// Stage 是交付阶段：执行者交了 PR 之后，运行时推进它；状态保持 running 直到合入（或上线）。
type Stage string

const (
	StageNone     Stage = ""
	StageGate     Stage = "gate"        // 关卡：运行时查事实
	StageReview   Stage = "review"      // 另一个模型审阅
	StageMerge    Stage = "merge_queue" // 合入队列
	StageMerged   Stage = "merged"      // 已合入，等发版
	StageReleased Stage = "released"    // 已上线
)

// MaxBounces：交回原执行者的次数上限，再不过转受阻。
const MaxBounces = 2

// State 是任务可变的两个维度。
type State struct {
	Status Status `json:"status"`
	Stage  Stage  `json:"stage"`
}

// Event 是推动状态的事。Kind 之外的字段只对特定 Kind 有意义。
type Event struct {
	Kind EventKind
	// To：Set 的目标状态。
	To Status
	// NeedReview：GatePass 后是否先审阅。
	NeedReview bool
	// NoMerge：GatePass/ReviewPass 时没有 PR 要合（调研类任务），直接完成。
	NoMerge bool
	// NeedRelease：Merged 后是否等发版（Atrium 自己的仓库）。
	NeedRelease bool
	// Bounces：Bounce 之前已交回过几次（从 task_events 数）。
	Bounces int
}

type EventKind string

const (
	Enqueue    EventKind = "enqueue"     // 进派活队列（task run）
	Start      EventKind = "start"       // 执行者进程已拉起
	ExitOK     EventKind = "exit_ok"     // 执行者正常退出，进关卡
	ExitFail   EventKind = "exit_fail"   // 执行者失败且重试用尽
	GatePass   EventKind = "gate_pass"   // 关卡通过
	ReviewPass EventKind = "review_pass" // 审阅通过
	Bounce     EventKind = "bounce"      // 关卡不过、审阅打回、合入冲突：交回原执行者
	Merged     EventKind = "merged"      // 已合入
	Released   EventKind = "released"    // 已上线
	Block      EventKind = "block"       // 缺条件、等决策
	Cancel     EventKind = "cancel"      // 不做了
	Set        EventKind = "set"         // 人工改状态（task set --status）
	Deliver    EventKind = "deliver"     // 人工放进合入队列（task merge：登记亲手做的 PR，或放行受阻的交付）
)

// Transition 是状态机的唯一判定：纯函数，不碰库和时间。
func Transition(from State, e Event) (State, error) {
	s, st := from.Status, from.Stage
	reject := func(format string, a ...any) (State, error) {
		return from, fmt.Errorf(format, a...)
	}
	delivering := s == Running && st != StageNone
	switch e.Kind {
	case Enqueue:
		if s == Todo || s == Failed || s == Blocked {
			return State{Queued, StageNone}, nil
		}
		return reject("任务当前 %s，不能派活（只有 todo、failed、blocked 能派）", s)
	case Start:
		if s == Queued {
			return State{Running, StageNone}, nil
		}
		return reject("任务当前 %s，不在派活队列里，不能拉起", s)
	case ExitOK, ExitFail:
		if s != Running || st != StageNone {
			return reject("任务当前 %s/%s，没有在跑的执行者", s, st)
		}
		if e.Kind == ExitOK {
			return State{Running, StageGate}, nil
		}
		return State{Failed, StageNone}, nil
	case GatePass:
		if !delivering || st != StageGate {
			return reject("任务不在关卡阶段（当前 %s/%s）", s, st)
		}
		switch {
		case e.NoMerge:
			return State{Done, StageGate}, nil
		case e.NeedReview:
			return State{Running, StageReview}, nil
		}
		return State{Running, StageMerge}, nil
	case ReviewPass:
		if !delivering || st != StageReview {
			return reject("任务不在审阅阶段（当前 %s/%s）", s, st)
		}
		if e.NoMerge {
			return State{Done, StageReview}, nil
		}
		return State{Running, StageMerge}, nil
	case Bounce:
		if !delivering || (st != StageGate && st != StageReview && st != StageMerge) {
			return reject("任务不在关卡、审阅或合入队列（当前 %s/%s），无可交回", s, st)
		}
		if e.Bounces >= MaxBounces {
			return State{Blocked, st}, nil
		}
		return State{Queued, StageNone}, nil
	case Merged:
		if !delivering || st != StageMerge {
			return reject("任务不在合入队列（当前 %s/%s）", s, st)
		}
		if e.NeedRelease {
			return State{Running, StageMerged}, nil
		}
		return State{Done, StageMerged}, nil
	case Released:
		if !delivering || st != StageMerged {
			return reject("任务不在等发版（当前 %s/%s）", s, st)
		}
		return State{Done, StageReleased}, nil
	case Block:
		if s == Todo || s == Queued || s == Running {
			return State{Blocked, st}, nil
		}
		return reject("任务当前 %s，不能标受阻", s)
	case Cancel:
		if s == Done || s == Cancelled {
			return reject("任务已%s，不能取消", map[Status]string{Done: "完成", Cancelled: "取消"}[s])
		}
		return State{Cancelled, st}, nil
	case Deliver:
		if s == Todo || s == Failed || s == Blocked {
			return State{Running, StageMerge}, nil
		}
		return reject("任务当前 %s，不能放进合入队列（只有 todo、failed、blocked 能放）", s)
	case Set:
		switch e.To {
		case Queued, Running:
			return reject("%s 只能由运行时进入：派活用 atrium task run", e.To)
		case Todo:
			return State{Todo, StageNone}, nil
		case Done, Failed, Blocked, Cancelled:
			return State{e.To, st}, nil
		}
		return reject("未知状态 %q（可选 todo、done、failed、blocked、cancelled）", e.To)
	}
	return reject("未知事件 %q", e.Kind)
}
