package dispatch

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// Fact 是一位候选执行者的事实（运行时收集）。
type Fact struct {
	ID          string
	Tool        string
	Model       string
	Account     string
	Trust       string
	MaxRisk     string
	Refusal     string // 档案是否接受自动分派任务（workers.Rules.Refusal）
	Problem     string // 档案写得不对、模型与强度不搭
	Unavailable string // 没有符合任务条件的可用主机，或隔离实例不允许
	Waiting     string // 主机暂未就绪；仍符合条件，等待后再派
	Exclusive   bool
	Preferred   int          // 技能里的优先顺序（1 起）；0 不是
	Stat        workers.Stat // 近 StatWindow 次表现；拉起次数用于同档轮转
	Fails       int          // 这个「工具+模型」近 ShakyWindow 次拉起里启动失败几次（workers.Fails）
}

// 近 ShakyWindow 次拉起里启动失败（额度、起不来、其他）≥ ShakyFails 次的候选往后排：只影响排序、不排除；
// 此刻接不了由不可用标记管（Unavailable）。
const (
	ShakyWindow = 5
	ShakyFails  = 2
)

// Shaky 纯判定：近期启动失败多，挑执行者时往后排。
func Shaky(fails int) bool { return fails >= ShakyFails }

// PickInput 是挑执行者的全部输入。
type PickInput struct {
	Risk     string
	Priority ledger.Priority // 活的分量：紧急、修复只交给够 trust 的（NeedTrust）
	Facts    []Fact
	Spares   map[string]Spare // 账号 → 富余与能不能派；没有的账号表示没数据
	Busy     map[string]bool  // 在跑的独占工具
	Exclude  map[string]bool  // 这一轮已试过的执行者（换人时不再挑）
}

// Candidate 是 --dry-run 列出的一位候选。
type Candidate struct {
	ID       string       `json:"id"`
	Stat     workers.Stat `json:"stat"`
	Trust    string       `json:"trust"`
	MaxRisk  string       `json:"max_risk"`
	Eligible bool         `json:"eligible"`
	Refusals []string     `json:"refusals,omitempty"`
	Busy     bool         `json:"busy,omitempty"`
	Spare    *float64     `json:"spare,omitempty"` // 富余百分点（与 atrium quota 同一个数）；没数据为空
	Rank     int          `json:"rank,omitempty"`  // 能接的里排第几（1 起）
	Fails    int          `json:"fails,omitempty"` // 近 ShakyWindow 次拉起里启动失败几次
}

// PickView 是挑执行者的结论：候选（能接的按推荐顺序在前）、推荐与理由。
type PickView struct {
	Risk        string      `json:"risk"`
	Candidates  []Candidate `json:"candidates"`
	Recommended string      `json:"recommended,omitempty"`
	Reason      string      `json:"reason"`
	// Waiting：有符合条件的候选，但工具正忙或主机暂未就绪；为假且没有推荐表示没人能接。
	Waiting bool `json:"waiting,omitempty"`
}

// NeedTrust 纯判定：活的分量要求的最低 trust。紧急、修复，或 risk 高于 low 的活只交给 trust≥medium 的；其余不限（空）。
// 返回要求与缘由（给候选的拒绝理由用）。
func NeedTrust(priority ledger.Priority, risk string) (min, why string) {
	switch {
	case priority == ledger.Urgent:
		return "medium", "紧急的活"
	case priority == ledger.Fix:
		return "medium", "修复的活"
	case workers.RiskLevel(risk) > workers.RiskLevel("low"):
		return "medium", "risk=" + risk + " 的活"
	}
	return "", ""
}

// Pick 挑执行者（纯函数）：档案能接、装了、本机没标不可用、trust 够活的分量（NeedTrust）、额度没见底；
// 能接的先把近期启动失败多的（Shaky）排到后面，再按技能优先分档；同档按近期拉起次数升序、额度富余降序排
// （次数相同时，没有富余数据的排在有的后面，之间按档案顺序）；正忙的跳过。
func Pick(in PickInput) PickView {
	minTrust, heavy := NeedTrust(in.Priority, in.Risk)
	v := PickView{Risk: in.Risk, Candidates: []Candidate{}}
	type row struct {
		c     Candidate
		wait  string
		pref  int
		order int
	}
	var ok, no []row
	anyData := false
	for i, f := range in.Facts {
		c := Candidate{ID: f.ID, Trust: f.Trust, MaxRisk: f.MaxRisk, Fails: f.Fails, Stat: f.Stat}
		if f.Problem != "" {
			c.Refusals = append(c.Refusals, f.Problem)
		}
		if f.Unavailable != "" {
			c.Refusals = append(c.Refusals, f.Unavailable)
		}
		if f.Refusal != "" {
			c.Refusals = append(c.Refusals, f.Refusal)
		}
		if minTrust != "" && workers.TrustLevel(f.Trust) < workers.TrustLevel(minTrust) {
			c.Refusals = append(c.Refusals, fmt.Sprintf("%s要 trust≥%s，它是 %s", heavy, minTrust, f.Trust))
		}
		if in.Exclude[f.ID] {
			c.Refusals = append(c.Refusals, "这一轮已试过")
		}
		if s, has := in.Spares[f.Account]; has {
			if s.Stop != "" {
				c.Refusals = append(c.Refusals, s.Stop)
			}
			if s.Percent != nil {
				c.Spare = s.Percent
				anyData = true
			}
		}
		c.Busy = f.Exclusive && in.Busy[f.Tool]
		c.Eligible = len(c.Refusals) == 0
		pref := f.Preferred
		if pref == 0 {
			pref = 1 << 30
		}
		if c.Eligible {
			ok = append(ok, row{c, f.Waiting, pref, i})
		} else {
			no = append(no, row{c, f.Waiting, pref, i})
		}
	}
	sort.SliceStable(ok, func(i, j int) bool {
		a, b := ok[i], ok[j]
		if sa, sb := Shaky(a.c.Fails), Shaky(b.c.Fails); sa != sb {
			return sb
		}
		if a.pref != b.pref {
			return a.pref < b.pref
		}
		if a.c.Stat.Launches != b.c.Stat.Launches {
			return a.c.Stat.Launches < b.c.Stat.Launches
		}
		if (a.c.Spare == nil) != (b.c.Spare == nil) {
			return a.c.Spare != nil
		}
		if a.c.Spare != nil && *a.c.Spare != *b.c.Spare {
			return *a.c.Spare > *b.c.Spare
		}
		return a.order < b.order
	})
	for i, r := range ok {
		r.c.Rank = i + 1
		v.Candidates = append(v.Candidates, r.c)
	}
	for _, r := range no {
		v.Candidates = append(v.Candidates, r.c)
	}
	for _, r := range ok {
		if r.c.Busy || r.wait != "" {
			continue
		}
		v.Recommended = r.c.ID
		switch {
		case r.pref < 1<<30:
			v.Reason = fmt.Sprintf("技能指定的第 %d 优先执行者", r.pref)
		case r.c.Spare != nil:
			v.Reason = "能接的里额度富余最多（" + strconv.FormatFloat(*r.c.Spare, 'f', 1, 64) + " 个百分点）"
		case anyData:
			v.Reason = "有数据的账号都排在它后面或不能接；它没有额度数据，按档案顺序"
		default:
			v.Reason = "没有额度数据，按档案顺序取第一个能接的"
		}
		if minTrust != "" {
			v.Reason = heavy + "只在 trust≥" + minTrust + " 的里挑；" + v.Reason
		}
		if Shaky(r.c.Fails) {
			v.Reason += fmt.Sprintf("；它近 %d 次拉起启动失败 %d 次，但没有更稳的能接", ShakyWindow, r.c.Fails)
			return v
		}
		var shaky []string
		for _, x := range ok {
			if Shaky(x.c.Fails) {
				shaky = append(shaky, fmt.Sprintf("%s 近 %d 次拉起启动失败 %d 次", x.c.ID, ShakyWindow, x.c.Fails))
			}
		}
		if len(shaky) > 0 {
			v.Reason += "；" + strings.Join(shaky, "、") + "，排在后面"
		}
		return v
	}
	if len(ok) > 0 {
		v.Waiting = true
		if ok[0].wait != "" {
			v.Reason = ok[0].c.ID + "：" + ok[0].wait
			return v
		}
		v.Reason = "能接的都正忙（独占工具在跑）：" + ok[0].c.ID + " 空下来就派"
		return v
	}
	v.Reason = "没有能接的执行者"
	if len(no) > 0 {
		var why []string
		for _, r := range no[:min(len(no), 3)] {
			why = append(why, r.c.ID+"："+strings.Join(r.c.Refusals, "、"))
		}
		v.Reason += "（" + strings.Join(why, "；") + "）"
	}
	return v
}

func itoa(n int) string { return strconv.Itoa(n) }
