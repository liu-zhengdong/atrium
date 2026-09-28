package dispatch

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Fact 是一位候选执行者的事实（运行时收集）。
type Fact struct {
	ID        string
	Tool      string
	Account   string
	Trust     string
	MaxRisk   string
	Refusal   string // 档案接不接这个风险（workers.Rules.Refusal）
	Problem   string // 档案写得不对、模型与强度不搭
	Installed bool
	Exclusive bool
	Preferred int // 技能里的优先顺序（1 起）；0 不是
}

// PickInput 是挑执行者的全部输入。
type PickInput struct {
	Risk    string
	Facts   []Fact
	Spares  map[string]Spare // 账号 → 富余；没有的账号表示没数据
	Busy    map[string]bool  // 在跑的独占工具
	Exclude map[string]bool  // 这一轮已试过的执行者（换人时不再挑）
}

// Candidate 是 --dry-run 列出的一位候选。
type Candidate struct {
	ID       string   `json:"id"`
	Trust    string   `json:"trust"`
	MaxRisk  string   `json:"max_risk"`
	Eligible bool     `json:"eligible"`
	Refusals []string `json:"refusals,omitempty"`
	Busy     bool     `json:"busy,omitempty"`
	Spare    *float64 `json:"spare,omitempty"` // 富余百分点；没数据为空
	Rank     int      `json:"rank,omitempty"`  // 能接的里排第几（1 起）
}

// PickView 是挑执行者的结论：候选（能接的按推荐顺序在前）、推荐与理由。
type PickView struct {
	Risk        string      `json:"risk"`
	Candidates  []Candidate `json:"candidates"`
	Recommended string      `json:"recommended,omitempty"`
	Reason      string      `json:"reason"`
	// Waiting：有能接的但都正忙（独占工具在跑），等它空下来；为假且没有推荐表示没人能接。
	Waiting bool `json:"waiting,omitempty"`
}

// Pick 挑执行者（纯函数）：档案能接、装了、额度没见底、没被标用尽；能接的按技能优先、额度富余排，
// 没有额度数据按档案顺序；正忙的跳过。
func Pick(in PickInput) PickView {
	v := PickView{Risk: in.Risk, Candidates: []Candidate{}}
	type row struct {
		c     Candidate
		pref  int
		order int
	}
	var ok, no []row
	anyData := false
	for i, f := range in.Facts {
		c := Candidate{ID: f.ID, Trust: f.Trust, MaxRisk: f.MaxRisk}
		if f.Problem != "" {
			c.Refusals = append(c.Refusals, f.Problem)
		}
		if !f.Installed {
			c.Refusals = append(c.Refusals, "没装："+f.Tool+" 不在 PATH 上")
		}
		if f.Refusal != "" {
			c.Refusals = append(c.Refusals, f.Refusal)
		}
		if in.Exclude[f.ID] {
			c.Refusals = append(c.Refusals, "这一轮已试过")
		}
		if s, has := in.Spares[f.Account]; has {
			switch {
			case s.Held:
				c.Refusals = append(c.Refusals, "额度用尽："+s.Reason)
			case s.Known && s.Room <= 0:
				c.Refusals = append(c.Refusals, "额度见底："+s.Reason)
			}
			if s.Known {
				room := s.Room
				c.Spare = &room
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
			ok = append(ok, row{c, pref, i})
		} else {
			no = append(no, row{c, pref, i})
		}
	}
	sort.SliceStable(ok, func(i, j int) bool {
		a, b := ok[i], ok[j]
		if a.pref != b.pref {
			return a.pref < b.pref
		}
		if anyData {
			as, bs := spareOr(a.c.Spare), spareOr(b.c.Spare)
			if as != bs {
				return as > bs
			}
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
		if r.c.Busy {
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
		return v
	}
	if len(ok) > 0 {
		v.Waiting = true
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

func spareOr(p *float64) float64 {
	if p == nil {
		return -1
	}
	return *p
}

func itoa(n int) string { return strconv.Itoa(n) }
