package ledger

import "fmt"

// Status 是任务状态。
type Status string

const (
	Draft     Status = "draft" // 草稿：还没想清楚、条件还不够；不分派任务、不计时
	Todo      Status = "todo"
	Queued    Status = "queued"
	Running   Status = "running"
	Done      Status = "done"
	Failed    Status = "failed"
	Blocked   Status = "blocked"
	Cancelled Status = "cancelled"
)

var Statuses = []Status{Draft, Todo, Queued, Running, Done, Failed, Blocked, Cancelled}

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

// Stage 是交付阶段：执行者交付之后由运行时（和验收人）推进；状态保持 running 直到应用完成。
// 核心一生是 交付检查 → 审阅（可选）→ 验收（部门的验收人不是运行时才有）→ 应用；应用的步骤归交付方式（gates），
// 核心只认「应用中」（Landing）与「应用完成」。
type Stage string

const (
	StageNone   Stage = ""
	StageGate   Stage = "gate"   // 交付检查：运行时查事实
	StageReview Stage = "review" // 审阅轮：在原任务上另拉一个执行者审阅（不建新任务）
	StageAccept Stage = "accept" // 等验收人（部门设置的 leader 或 user）判
)

// pr 交付方式的应用步骤（合入队列 → 已合入等发版 → 已上线）。核心不认它们的先后，只当应用中的阶段名；
// merge、release 经 Land 推进，watch、web 按它们写人话。放在这里是因为 watch、web 在 gates 之下，引用不到 gates。
const (
	StageMerge    Stage = "merge_queue"
	StageMerged   Stage = "merged"
	StageReleased Stage = "released"
)

// Landing 判一个阶段是不是应用中（交付方式自己的步骤）。
func (s Stage) Landing() bool {
	return s != StageNone && s != StageGate && s != StageReview && s != StageAccept
}

// MaxBounces：交回原执行者的次数上限，再不过转受阻。
const MaxBounces = 2

// State 是任务可变的两个维度。
type State struct {
	Status Status `json:"status"`
	Stage  Stage  `json:"stage"`
}

// Event 是推动状态的事。Kind 之外的字段只对特定 Kind 有意义。
type Event struct {
	Kind  EventKind
	Epoch int64  // 验收对应的交付经历
	Head  string // 验收对应的 PR head
	// To：Set 的目标状态。
	To Status
	// NeedReview：GatePass 后是否先审阅。
	NeedReview bool
	// AcceptBy：GatePass、ReviewPass、Deliver 后要等谁验收（leader、user）；空表示不用等人，直接应用。
	AcceptBy string
	// Land：应用的下一步（交付方式的阶段）。GatePass、ReviewPass、Accept 时为空表示当场应用完成、任务完成；
	// Land 事件把任务推到这一步，Final 为真时同时完成。
	Land  Stage
	Final bool
	// Bounces：Bounce 之前已交回过几次（从 task_events 数）。
	Bounces int
}

type EventKind string

const (
	Enqueue    EventKind = "enqueue"     // 进分派任务队列（task run）
	Requeue    EventKind = "requeue"     // 执行者退出要换人、能换的此刻都被不可用标记挡着：放回队列等（运行时）
	Start      EventKind = "start"       // 执行者进程已拉起
	ExitOK     EventKind = "exit_ok"     // 执行者正常退出，进入交付检查
	ExitFail   EventKind = "exit_fail"   // 执行者失败且重试用尽
	GatePass   EventKind = "gate_pass"   // 交付检查通过
	ReviewPass EventKind = "review_pass" // 审阅通过
	Accept     EventKind = "accept"      // 验收通过（task accept）
	Bounce     EventKind = "bounce"      // 交付检查未通过、审阅打回、验收打回、应用失败：交回原执行者
	Land       EventKind = "land"        // 应用推进一步（如已合入、已上线）
	Block      EventKind = "block"       // 缺条件、等决策
	Cancel     EventKind = "cancel"      // 不做了
	Set        EventKind = "set"         // 人工改状态（task set --status）
	Deliver    EventKind = "deliver"     // 人工放进应用（task merge：登记亲手做的 PR，或放行受阻的交付）
)

// passTo 是过了交付检查、审阅或验收之后去哪：要等人验收 → accept；交付方式有应用步骤 → 那一步；否则当场完成（阶段留在 st）。
func passTo(e Event, st Stage) (State, error) {
	switch {
	case e.AcceptBy != "":
		return State{Running, StageAccept}, nil
	case e.Land == "":
		return State{Done, st}, nil
	case !e.Land.Landing():
		return State{}, fmt.Errorf("%q 不是应用步骤", e.Land)
	}
	return State{Running, e.Land}, nil
}

// Transition 是状态机的唯一判定：纯函数，不碰库和时间。
func Transition(from State, e Event) (State, error) {
	s, st := from.Status, from.Stage
	reject := func(format string, a ...any) (State, error) {
		return from, fmt.Errorf(format, a...)
	}
	delivering := s == Running && st != StageNone
	// 审阅阶段受阻（多是审阅任务失败）后审阅重跑出了结论，仍按结论走：过、打回、或换个原因再受阻。
	reviewing := st == StageReview && (s == Running || s == Blocked)
	passOr := func(e Event, st Stage) (State, error) {
		next, err := passTo(e, st)
		if err != nil {
			return reject("%v", err)
		}
		return next, nil
	}
	switch e.Kind {
	case Enqueue:
		if s == Draft || s == Todo || s == Failed || s == Blocked {
			return State{Queued, StageNone}, nil
		}
		return reject("任务当前 %s，不能分派任务（只有 draft、todo、failed、blocked 能派）", s)
	case Requeue:
		if s == Running && st == StageNone {
			return State{Queued, StageNone}, nil
		}
		return reject("任务当前 %s/%s，没有在跑的执行者，不能放回队列", s, st)
	case Start:
		if s == Queued {
			return State{Running, StageNone}, nil
		}
		return reject("任务当前 %s，不在分派任务队列里，不能拉起", s)
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
			return reject("任务不在交付检查阶段（当前 %s/%s）", s, st)
		}
		if e.NeedReview {
			return State{Running, StageReview}, nil
		}
		return passOr(e, st)
	case ReviewPass:
		if !reviewing {
			return reject("任务不在审阅阶段（当前 %s/%s）", s, st)
		}
		return passOr(e, st)
	case Accept:
		if !delivering || st != StageAccept {
			return reject("任务不在等验收（当前 %s/%s）", s, st)
		}
		e.AcceptBy = ""
		return passOr(e, st)
	case Bounce:
		if !delivering && !reviewing {
			return reject("任务不在交付中（当前 %s/%s），无可交回", s, st)
		}
		if e.Bounces >= MaxBounces {
			return State{Blocked, st}, nil
		}
		return State{Queued, StageNone}, nil
	case Land:
		if !delivering || !st.Landing() {
			return reject("任务不在应用中（当前 %s/%s）", s, st)
		}
		if !e.Land.Landing() {
			return reject("%q 不是应用步骤", e.Land)
		}
		if e.Final {
			return State{Done, e.Land}, nil
		}
		return State{Running, e.Land}, nil
	case Block:
		if s == Todo || s == Queued || s == Running || reviewing {
			return State{Blocked, st}, nil
		}
		return reject("任务当前 %s，不能标受阻", s)
	case Cancel:
		if s == Done || s == Cancelled {
			return reject("任务已%s，不能取消", map[Status]string{Done: "完成", Cancelled: "取消"}[s])
		}
		return State{Cancelled, st}, nil
	case Deliver:
		if s != Todo && s != Failed && s != Blocked && !(delivering && st.Landing() && e.AcceptBy != "") {
			return reject("任务当前 %s，不能放进应用（只有 todo、failed、blocked 能放）", s)
		}
		if e.AcceptBy == "" && e.Land == "" {
			return reject("放进应用要给应用步骤")
		}
		return passOr(e, st)
	case Set:
		switch e.To {
		case Queued, Running:
			return reject("%s 只能由运行时进入：分派任务用 atrium task run", e.To)
		case Todo:
			return State{Todo, StageNone}, nil
		case Draft:
			if s == Todo || s == Failed || s == Blocked {
				return State{Draft, StageNone}, nil
			}
			return reject("任务当前 %s，不能退回草稿（只有 todo、failed、blocked 能退回）", s)
		case Done, Failed, Blocked, Cancelled:
			return State{e.To, st}, nil
		}
		return reject("未知状态 %q（可选 draft、todo、done、failed、blocked、cancelled）", e.To)
	}
	return reject("未知事件 %q", e.Kind)
}
