package quota

import (
	"fmt"
	"sort"
	"strings"
)

// Stored 是 quota_cache 的一行：某台机器对某个账号的最近一次读数。
type Stored struct {
	Host string `json:"host"`
	Reading
}

// lastGood：读不到时上次读数最多沿用多久。
const lastGood = 6 * 3600_000

// Accounts 是派活认识的全部账号（与执行者工具对应：agy 的账号是 antigravity）。
var Accounts = []string{"claude", "codex", "opencode", "kimi", "grok", "cursor", "antigravity"}

// AccountOf 是执行者工具对应的额度账号。
func AccountOf(tool string) string {
	if tool == "agy" {
		return "antigravity"
	}
	return tool
}

// Line 是 quota 一览的一行，也是判富余的依据。
type Line struct {
	Pace
	Source string `json:"source"`         // builtin、openquota；两边都没有为空
	Note   string `json:"note,omitempty"` // 读不到的原因、沿用上次读数、读自哪台……
	From   string `json:"from,omitempty"` // 自带读数来自哪台机器
	Hold   *Hold  `json:"hold,omitempty"`
}

// Hold 是额度用尽标记。
type Hold struct {
	Until  int64  `json:"until"`
	Reason string `json:"reason"`
}

// mergeHosts 按账号合并各台机器的自带读数（纯函数）：同一指纹只算一份（存储时已按指纹合一行）；
// 本机登录的那个账号优先，本机没读到就用最新的；别的机器登录的是另一个账号时在说明里写明没算进来。
func mergeHosts(rows []Stored, local string, now int64) map[string]Line {
	byAcct := map[string][]Stored{}
	for _, r := range rows {
		byAcct[r.Account] = append(byAcct[r.Account], r)
	}
	out := map[string]Line{}
	for acct, list := range byAcct {
		var goods, fails []Stored
		for _, r := range list {
			if r.OK && now-r.ReadAt <= lastGood {
				goods = append(goods, r)
			} else if !r.OK {
				fails = append(fails, r)
			}
		}
		if len(goods) == 0 {
			reason := "没有额度数据"
			for _, f := range fails {
				if f.Host == local {
					reason = f.Reason
					break
				}
				reason = fmt.Sprintf("%s（%s）", f.Reason, f.Host)
			}
			out[acct] = Line{Pace: Pace{Account: acct}, Source: "builtin", Note: "读不到：" + reason}
			continue
		}
		sort.Slice(goods, func(i, j int) bool {
			li, lj := goods[i].Host == local, goods[j].Host == local
			if li != lj {
				return li
			}
			return goods[i].ReadAt > goods[j].ReadAt
		})
		pick := goods[0]
		var notes, others []string
		for _, f := range fails {
			if f.Host == pick.Host && f.ReadAt > pick.ReadAt {
				notes = append(notes, "本次读不到（"+f.Reason+"），沿用上次读数")
			}
		}
		if pick.Host != local {
			notes = append(notes, "读自 "+pick.Host)
		}
		for _, g := range goods[1:] {
			others = append(others, g.Host)
		}
		if len(others) > 0 {
			notes = append(notes, strings.Join(others, "、")+" 登录的是另一个账号，没算进来")
		}
		out[acct] = Line{Pace: PaceOf(pick.Reading, now), Source: "builtin", Note: strings.Join(notes, "；"), From: pick.Host}
	}
	return out
}

// Lines 合并来源（纯函数）：自带读到的优先；自带没覆盖或读不到的，OpenQuota 有就补；都没有写「没有额度数据」。
// 结果按富余降序，没有富余数据与旧数排最后。
func Lines(builtin map[string]Line, oq []Pace, holds map[string]Hold, now int64) []Line {
	byAcct := map[string]Line{}
	for a, l := range builtin {
		byAcct[a] = l
	}
	for _, p := range oq {
		if p.Account == "" {
			continue
		}
		cur, ok := byAcct[p.Account]
		if ok && cur.UsedPercent != nil {
			continue
		}
		l := Line{Pace: p, Source: "openquota"}
		if ok {
			l.Note = "自带" + cur.Note
		}
		byAcct[p.Account] = l
	}
	for _, a := range Accounts {
		if _, ok := byAcct[a]; !ok {
			byAcct[a] = Line{Pace: Pace{Account: a}, Note: "没有额度数据"}
		}
	}
	var out []Line
	for a, l := range byAcct {
		if h, ok := holds[a]; ok && h.Until > now {
			l.Hold = &h
		}
		out = append(out, l)
	}
	spare := func(l Line) *float64 {
		if l.Stale {
			return nil
		}
		return l.SparePercent
	}
	sort.Slice(out, func(i, j int) bool {
		si, sj := spare(out[i]), spare(out[j])
		switch {
		case si == nil && sj == nil:
			return out[i].Account < out[j].Account
		case si == nil:
			return false
		case sj == nil:
			return true
		case *si != *sj:
			return *si > *sj
		}
		return out[i].Account < out[j].Account
	})
	return out
}

// Spare 是给派活的一个账号的富余。
type Spare struct {
	Account string `json:"account"`
	// Known：有已用比例。没有数据时不猜，派活照常（Room 为 0，Reason 写明）。
	Known bool `json:"known"`
	// Room = 100 − 给用户留的份额 − 已用（周窗与短窗取紧的）；≤ 0 不该再派。
	Room  float64 `json:"room"`
	Stale bool    `json:"stale"` // 读数超过 10 分钟
	// Held：额度用尽标记未到期，不派。
	Held   bool   `json:"held"`
	Reason string `json:"reason,omitempty"`
}

// SpareOf 判一个账号的富余（纯函数）。
func SpareOf(l Line, reserve int) Spare {
	s := Spare{Account: l.Account, Stale: l.Stale}
	if l.Hold != nil {
		s.Held = true
		s.Reason = l.Hold.Reason
	}
	if l.UsedPercent == nil {
		if s.Reason == "" {
			s.Reason = "没有额度数据：" + l.Note
		}
		return s
	}
	used := *l.UsedPercent
	if l.ShortUsedPct != nil && *l.ShortUsedPct >= 100 {
		used = 100
	}
	s.Known = true
	s.Room = round1(100 - float64(reserve) - used)
	if s.Reason == "" && s.Room <= 0 {
		s.Reason = fmt.Sprintf("账号 %s 已用 %.1f%%，须给用户留 %d%%", l.Account, used, reserve)
	}
	return s
}
