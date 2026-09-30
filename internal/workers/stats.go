package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// 按拉起统计：每次拉起（任务经历 launch）一个结果，按「工具+模型」归（强度不单列）。
// 结果由 dispatch 在执行者退出时记（经历 kind "exit"，正文 Exit）；之后被交回的改记「被交回」。

// ExitKind 是这次拉起结果在任务经历里的 kind。
const ExitKind = "exit"

// StatWindow：workers 列每个组合近几次有结果的拉起。
const StatWindow = 20

// 一次拉起的结果。启动失败（额度、起不来、其他）的分类同不可用标记，取自退出信号。
const (
	OutOK     = "ok"     // 正常交付
	OutQuota  = "quota"  // 额度用尽
	OutSetup  = "setup"  // 起不来：没登录、缺运行环境、零步骤出错退出
	OutFail   = "fail"   // 其他失败：模型名无效、临时错误、思考耗尽、出错退出、卡死
	OutBounce = "bounce" // 交付被交回（关卡、审阅、验收、合入退回）
)

var outText = map[string]string{OutOK: "交付", OutQuota: "额度", OutSetup: "起不来", OutFail: "其他失败", OutBounce: "被交回"}

// OutText 是结果给人看的名字。
func OutText(out string) string { return outText[out] }

// Exit 是经历 kind "exit" 的正文：第几次拉起、实际用的模型、结果与原因。
type Exit struct {
	N       int    `json:"n"`
	Model   string `json:"model,omitempty"` // 工具在日志里报的实际模型（ModelOf）；没写模型、跟随工具缺省时看它解析到了哪个
	Outcome string `json:"outcome"`
	Reason  string `json:"reason,omitempty"`
}

// OutcomeOf 把退出信号翻成这次拉起的结果（纯函数）：额度用尽、起不来（含零步骤出错退出）各一类；没有信号且正常收尾算交付；其余算其他失败。
func OutcomeOf(sig Signal, ended bool) string {
	switch {
	case sig.Kind == SignalQuota:
		return OutQuota
	case sig.Kind == SignalSetup, sig.Kind == SignalNoStart:
		return OutSetup
	case sig.Kind == SignalNone && ended:
		return OutOK
	}
	return OutFail
}

// Failed：启动失败（额度、起不来、其他）。
func Failed(out string) bool { return out == OutQuota || out == OutSetup || out == OutFail }

// Attempt 是一次拉起及其结果。
type Attempt struct {
	Task    string `json:"task"`
	N       int    `json:"n"`
	Worker  string `json:"worker"`          // 当时的执行者标识（含强度）
	Model   string `json:"model,omitempty"` // 工具报的实际模型
	Host    string `json:"host"`
	Outcome string `json:"outcome"` // 空：还在跑，或被人停下、取消（不计）
	Reason  string `json:"reason,omitempty"`
	At      int64  `json:"at"`
}

// Stat 是一个组合近几次有结果的拉起按结果数。
type Stat struct {
	Launches int `json:"launches"`
	OK       int `json:"ok"`
	Bounce   int `json:"bounce"`
	Quota    int `json:"quota"`
	Setup    int `json:"setup"`
	Fail     int `json:"fail"`
}

// Count 数 ls 里各结果几次（纯函数）。
func Count(ls []Attempt) Stat {
	s := Stat{Launches: len(ls)}
	for _, l := range ls {
		switch l.Outcome {
		case OutOK:
			s.OK++
		case OutBounce:
			s.Bounce++
		case OutQuota:
			s.Quota++
		case OutSetup:
			s.Setup++
		case OutFail:
			s.Fail++
		}
	}
	return s
}

func (s Stat) String() string {
	if s.Launches == 0 {
		return "还没有拉起记录"
	}
	return fmt.Sprintf("近 %d 次拉起：交付 %d · 被交回 %d · 额度 %d · 起不来 %d · 其他失败 %d", s.Launches, s.OK, s.Bounce, s.Quota, s.Setup, s.Fail)
}

// Fails 数最近 n 次有结果的拉起里启动失败几次（纯函数，ls 新的在前）。
func Fails(ls []Attempt, n int) int {
	k := 0
	for _, l := range ls[:min(n, len(ls))] {
		if Failed(l.Outcome) {
			k++
		}
	}
	return k
}

// Combo 是统计用的「工具+模型」（不含强度）；写不对的标识原样返回。
func Combo(worker string) string {
	s, err := ParseWorker(worker)
	if err != nil {
		return worker
	}
	return Spec{Tool: s.Tool, Model: s.Model}.String()
}

// Event 是判拉起结果要用的一条任务经历。
type Event struct {
	Kind string
	Body string
}

// Settle 把一件任务的经历（时间正序，只含 launch、exit、exit_ok、exit_fail、bounce）判成每次拉起的结果（纯函数）：
// 这次拉起到下次拉起之间有交回 → 被交回；否则看 exit 记录；没有（watch 直接收尾）看 exit_ok／exit_fail；都没有留空。
func Settle(task string, evs []Event) ([]Attempt, error) {
	var out []Attempt
	var cur *Attempt
	var bounce, exit, ended *Attempt // 这一段里各类经历给出的结果与原因（只用 Outcome、Reason；exit 另带 Model）
	flush := func() {
		if cur == nil {
			return
		}
		for _, x := range []*Attempt{bounce, exit, ended} {
			if x != nil {
				cur.Outcome, cur.Reason = x.Outcome, x.Reason
				break
			}
		}
		if exit != nil {
			cur.Model = exit.Model
		}
		out = append(out, *cur)
	}
	for _, e := range evs {
		switch e.Kind {
		case RunKind:
			flush()
			var r Run
			if err := json.Unmarshal([]byte(e.Body), &r); err != nil {
				return nil, fmt.Errorf("任务 %s 的拉起记录坏了：%w", task, err)
			}
			cur = &Attempt{Task: task, N: r.N, Worker: r.Worker, Host: r.Host, At: r.At}
			bounce, exit, ended = nil, nil, nil
		case ExitKind:
			var x Exit
			if err := json.Unmarshal([]byte(e.Body), &x); err != nil {
				return nil, fmt.Errorf("任务 %s 的退出记录坏了：%w", task, err)
			}
			if exit == nil {
				exit = &Attempt{Outcome: x.Outcome, Reason: x.Reason, Model: x.Model}
			}
		case "exit_ok", "exit_fail", "bounce":
			var b struct {
				Note string `json:"note"`
			}
			if err := json.Unmarshal([]byte(e.Body), &b); err != nil {
				return nil, fmt.Errorf("任务 %s 的经历 %s 坏了：%w", task, e.Kind, err)
			}
			switch e.Kind {
			case "bounce":
				if bounce == nil {
					bounce = &Attempt{Outcome: OutBounce, Reason: b.Note}
				}
			case "exit_ok":
				ended = &Attempt{Outcome: OutOK, Reason: b.Note}
			default:
				ended = &Attempt{Outcome: OutFail, Reason: b.Note}
			}
		}
	}
	flush()
	return out, nil
}

// statScan：统计从最近这么多条相关经历里数。
const statScan = 20000

// Stats 是各「工具+模型」近 StatWindow 次有结果的拉起（新的在前）。
func Stats(ctx context.Context, q store.Querier) (map[string][]Attempt, error) {
	rows, err := q.QueryContext(ctx, `SELECT task, kind, body FROM task_events
		WHERE kind IN (?, ?, 'exit_ok', 'exit_fail', 'bounce') ORDER BY id DESC LIMIT ?`, RunKind, ExitKind, statScan)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byTask := map[string][]Event{}
	var order []string // 按最近一条经历排的任务
	for rows.Next() {
		var task string
		var e Event
		if err := rows.Scan(&task, &e.Kind, &e.Body); err != nil {
			return nil, err
		}
		if _, ok := byTask[task]; !ok {
			order = append(order, task)
		}
		byTask[task] = append(byTask[task], e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var all []Attempt
	for _, task := range order {
		evs := byTask[task]
		for i, j := 0, len(evs)-1; i < j; i, j = i+1, j-1 {
			evs[i], evs[j] = evs[j], evs[i]
		}
		ls, err := Settle(task, evs)
		if err != nil {
			return nil, err
		}
		all = append(all, ls...)
	}
	return Recent(all, StatWindow), nil
}

// Recent 按「工具+模型」分组，各取最近 n 次有结果的拉起，新的在前（纯函数）。
func Recent(ls []Attempt, n int) map[string][]Attempt {
	sorted := append([]Attempt(nil), ls...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].At > sorted[j].At })
	out := map[string][]Attempt{}
	for _, l := range sorted {
		k := Combo(l.Worker)
		if l.Outcome == "" || len(out[k]) >= n {
			continue
		}
		out[k] = append(out[k], l)
	}
	return out
}
