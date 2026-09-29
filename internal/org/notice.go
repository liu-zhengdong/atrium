package org

import (
	"fmt"
	"strings"
)

// NoticeAct 是巡检对一项上限用量的动作。
type NoticeAct int

const (
	NoticeNone  NoticeAct = iota // 没到，或已提醒且仍满
	NoticeEmit                   // 刚到或超了，还没提醒
	NoticeClear                  // 已提醒过，现已回到上限以内
)

// NoticeRef 是「已经提醒过」的键：部门（全局为空串）+ 上限表的键。
type NoticeRef struct {
	Scope string
	Key   string
}

// LimitNotice 是该发给整理人的一条上限提醒。
type LimitNotice struct {
	Scope  string // 部门短号，全局为空
	Target string // 投递对象
	Limit  Limit
	Used   int
}

// EventKey 是事件去重键。事件表只合并没 ack 的；「超限期间、ack 之后、重启之后都不重发」靠 limit_notices。
func (n LimitNotice) EventKey() string {
	return "limit:" + n.Scope + ":" + n.Limit.Key
}

// DecideNotice 纯判定：没到不发；刚到或超了且未提醒则发；已提醒且仍满则不发；回落到上限以内则清掉已提醒。
func DecideNotice(used, max int, already bool) NoticeAct {
	full := used >= max
	switch {
	case full && !already:
		return NoticeEmit
	case !full && already:
		return NoticeClear
	default:
		return NoticeNone
	}
}

// AlertTo 是上限表「满了找谁」对应的投递对象。
// 部门负责人 = 该部门的处理人（Nearest / Recipient）；秘书、用户及其余 = 秘书。
func AlertTo(owner, leader string) string {
	if owner == "部门负责人" && leader != "" {
		return leader
	}
	return Secretary
}

// NoticeText 是刚到或超限时给人看的一句：哪一项、几/上限、找谁、怎么办。Full 也用这一句。
func NoticeText(l Limit, dept string, used int) string {
	where := ""
	if dept != "" {
		where = "部门 " + dept + " 的"
	}
	return fmt.Sprintf("%s%s已 %d/%d %s（满了找%s）：%s",
		where, l.What, used, l.Max, l.Unit, l.Owner, NoticeFix(l, dept))
}

// NoticeFix 是上限表的怎么办（Fix 里的 {dept} 换成部门短号）。
func NoticeFix(l Limit, dept string) string {
	return strings.ReplaceAll(l.Fix, "{dept}", dept)
}

// NoticeNext 是腾地方的第一条命令（上限表 Next 里的 {dept} 换成部门短号）。
func NoticeNext(l Limit, dept string) string {
	return strings.ReplaceAll(l.Next, "{dept}", dept)
}

// PlanNotices 纯判定：一组计数对照「已经提醒过」，列出该发的和该清的。
func PlanNotices(dept, leader string, counts []Count, already map[NoticeRef]struct{}) (emit []LimitNotice, clear []NoticeRef) {
	for _, c := range counts {
		ref := NoticeRef{Scope: dept, Key: c.Key}
		_, had := already[ref]
		switch DecideNotice(c.Used, c.Max, had) {
		case NoticeEmit:
			l := LimitOf(c.Key)
			emit = append(emit, LimitNotice{Scope: dept, Target: AlertTo(l.Owner, leader), Limit: l, Used: c.Used})
		case NoticeClear:
			clear = append(clear, ref)
		}
	}
	return emit, clear
}
