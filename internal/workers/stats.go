package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 按拉起统计：每次拉起（任务经历 launch）一个结果，按「工具+模型」归（强度不单列）；
// 统计键规范成目录组合名——只写工具名的拉起经 Resolve 补上缺省模型（claude 归进 claude+opus），同一执行者不因记账时的写法拆开。
// 结果由 dispatch 在执行者退出时记（经历 kind "exit"，正文 Exit）；之后被交回的改记「被交回」。

// ExitKind 是这次拉起结果在任务经历里的 kind。
const ExitKind = "exit"

// StatWindow：workers 列每个组合近几次有结果的拉起。
const StatWindow = 20

// 一次拉起的结果。启动失败（额度、起不来、其他）的分类同不可用标记，取自退出信号。
const (
	OutOK     = "ok"     // 正常交付
	OutQuota  = "quota"  // 额度用尽
	OutSetup  = "setup"  // 起不来：没登录、缺运行环境、工具版本过旧、零步骤出错退出
	OutFail   = "fail"   // 其他失败：模型名无效、临时错误、思考耗尽、出错退出、长时间没进展
	OutBounce = "bounce" // 交付被交回（交付检查、审阅、验收、合入退回）
)

var outText = map[string]string{OutOK: "交付", OutQuota: "额度", OutSetup: "起不来", OutFail: "其他失败", OutBounce: "被交回"}

// OutText 是结果给人看的名字。
func OutText(out string) string { return outText[out] }

// Exit 是经历 kind "exit" 的正文：第几次拉起、实际用的模型、结果与原因。
type Exit struct {
	Usage   Usage  `json:"usage"`
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
	Usage      Usage  `json:"usage"`
	Task       string `json:"task"`
	N          int    `json:"n"`
	Worker     string `json:"worker"`          // 当时的执行者标识（含强度）
	Model      string `json:"model,omitempty"` // 工具报的实际模型
	Host       string `json:"host"`
	Outcome    string `json:"outcome"` // 空：还在跑，或被人停下、取消（不计）
	Reason     string `json:"reason,omitempty"`
	At         int64  `json:"at"`
	DurationMS *int64 `json:"duration_ms"` // launch 到退出经历；缺失或时间倒置为空
}

// Stat 是一个组合近几次有结果的拉起的结果数与用时。
type Stat struct {
	Usage    []UsageMetric `json:"usage"`
	Launches int           `json:"launches"`
	OK       int           `json:"ok"`
	Bounce   int           `json:"bounce"`
	Quota    int           `json:"quota"`
	Setup    int           `json:"setup"`
	Fail     int           `json:"fail"`
	MedianMS *int64        `json:"median_ms"` // 排除启动失败的中位数
	MaxMS    *int64        `json:"max_ms"`    // 所有有效用时中的最长
}

// Count 汇总结果数与用时（纯函数）；启动失败不进入中位数，最长保留所有有效用时。
func Count(ls []Attempt) Stat {
	s := Stat{Launches: len(ls), Usage: usageStats(ls)}
	var durations []int64
	for _, l := range ls {
		if l.Outcome != "" && l.DurationMS != nil {
			d := *l.DurationMS
			if s.MaxMS == nil || d > *s.MaxMS {
				s.MaxMS = &d
			}
			if !Failed(l.Outcome) {
				durations = append(durations, d)
			}
		}
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
	s.MedianMS = median(durations)
	return s
}

func (s Stat) String() string {
	if s.Launches == 0 {
		return "还没有拉起记录 · " + s.Timing()
	}
	return fmt.Sprintf("近 %d 次拉起：交付 %d · 被交回 %d · 额度 %d · 起不来 %d · 其他失败 %d", s.Launches, s.OK, s.Bounce, s.Quota, s.Setup, s.Fail) + " · " + s.Timing() + " · " + s.UsageText()
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
	At   int64
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
		result := exit
		if result == nil {
			result = ended
		}
		if result != nil {
			cur.DurationMS = elapsed(cur.At, result.At)
		}
		if exit != nil {
			cur.Model = exit.Model
			cur.Usage = exit.Usage
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
			cur = &Attempt{Task: task, N: r.N, Worker: r.Worker, Host: r.Host, At: e.At}
			bounce, exit, ended = nil, nil, nil
		case ExitKind:
			var x Exit
			if err := json.Unmarshal([]byte(e.Body), &x); err != nil {
				return nil, fmt.Errorf("任务 %s 的退出记录坏了：%w", task, err)
			}
			if exit == nil {
				exit = &Attempt{Outcome: x.Outcome, Reason: x.Reason, Model: x.Model, At: e.At, Usage: x.Usage}
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
				if ended == nil {
					ended = &Attempt{Outcome: OutOK, Reason: b.Note, At: e.At}
				}
			default:
				if ended == nil {
					ended = &Attempt{Outcome: OutFail, Reason: b.Note, At: e.At}
				}
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
	stats, issues, err := StatsIssues(ctx, q)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(issues))
	for id := range issues {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if len(ids) > 0 {
		return nil, issues[ids[0]]
	}
	return stats, nil
}

// StatsIssues 返回可用统计与各自损坏的任务；共享查询失败单独返回。
// 后台调用方把 issues 交 ledger.EachTask，读命令仍由 Stats 严格报错。
func StatsIssues(ctx context.Context, q store.Querier) (map[string][]Attempt, map[string]error, error) {
	rows, err := q.QueryContext(ctx, `SELECT task, kind, body, at FROM task_events
		WHERE kind IN (?, ?, 'exit_ok', 'exit_fail', 'bounce') ORDER BY id DESC LIMIT ?`, RunKind, ExitKind, statScan)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	byTask := map[string][]Event{}
	var order []string // 按最近一条经历排的任务
	for rows.Next() {
		var task string
		var e Event
		if err := rows.Scan(&task, &e.Kind, &e.Body, &e.At); err != nil {
			return nil, nil, err
		}
		if _, ok := byTask[task]; !ok {
			order = append(order, task)
		}
		byTask[task] = append(byTask[task], e)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	issues := map[string]error{}
	var all []Attempt
	for _, task := range order {
		evs := byTask[task]
		for i, j := 0, len(evs)-1; i < j; i, j = i+1, j-1 {
			evs[i], evs[j] = evs[j], evs[i]
		}
		ls, err := Settle(task, evs)
		if err != nil {
			issues[task] = err
			continue
		}
		all = append(all, ls...)
	}
	keys, err := statKeys(ctx, q, attemptWorkers(all))
	if err != nil {
		return nil, nil, err
	}
	return Recent(all, StatWindow, statKeyOf(keys)), issues, nil
}

// Recent 按「工具+模型」分组，各取最近 n 次有结果的拉起，新的在前（纯函数）；
// key 把当时的执行者标识规范成统计键（statKeys 的产物）。
func Recent(ls []Attempt, n int, key func(string) string) map[string][]Attempt {
	sorted := append([]Attempt(nil), ls...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].At > sorted[j].At })
	out := map[string][]Attempt{}
	for _, l := range sorted {
		k := key(l.Worker)
		if l.Outcome == "" || len(out[k]) >= n {
			continue
		}
		out[k] = append(out[k], l)
	}
	return out
}

// statKeys 把要分组的执行者标识规范成统计键（目录组合名）：写明模型的组合名不变；
// 只写工具名的经 Resolve 补上缺省模型，与目录同名（未知工具、写错的标识解析不了，原样返回，落「不在目录里」）。
func statKeys(ctx context.Context, q store.Querier, ids []string) (map[string]string, error) {
	out := make(map[string]string, len(ids))
	for _, id := range ids {
		s, err := ParseWorker(id)
		if err != nil || s.Model != "" {
			out[id] = Combo(id)
			continue
		}
		r, err := Resolve(ctx, q, id)
		if err != nil {
			var ae *api.Error
			if !asAPI(err, &ae) {
				return nil, err
			}
			out[id] = Combo(id)
			continue
		}
		out[id] = Combo(r.ID)
	}
	return out, nil
}

// statKeyOf 把查好的键表包成分组函数；没查过的标识按老规矩只归「工具+模型」。
func statKeyOf(keys map[string]string) func(string) string {
	return func(w string) string {
		if k, ok := keys[w]; ok {
			return k
		}
		return Combo(w)
	}
}

// attemptWorkers 去重列出拉起里用到的执行者标识。
func attemptWorkers(ls []Attempt) []string {
	seen := map[string]bool{}
	var out []string
	for _, a := range ls {
		if !seen[a.Worker] {
			seen[a.Worker] = true
			out = append(out, a.Worker)
		}
	}
	return out
}
