package org

import (
	"reflect"
	"testing"
)

func TestDecideNotice(t *testing.T) {
	cases := []struct {
		name      string
		used, max int
		already   bool
		want      NoticeAct
	}{
		{"没到", 6, 7, false, NoticeNone},
		{"刚到", 7, 7, false, NoticeEmit},
		{"超了", 8, 7, false, NoticeEmit},
		{"已提醒过仍超", 8, 7, true, NoticeNone},
		{"已提醒过刚到", 7, 7, true, NoticeNone},
		{"回落", 6, 7, true, NoticeClear},
		{"回落后再超", 8, 7, false, NoticeEmit},
		{"空的", 0, 7, false, NoticeNone},
		{"回落后仍没到", 3, 7, false, NoticeNone},
	}
	for _, c := range cases {
		if got := DecideNotice(c.used, c.max, c.already); got != c.want {
			t.Errorf("%s：DecideNotice(%d, %d, %v) = %d，应为 %d", c.name, c.used, c.max, c.already, got, c.want)
		}
	}
}

func TestAlertTo(t *testing.T) {
	cases := []struct {
		owner, leader, want string
	}{
		{"部门负责人", "a2", "a2"},
		{"部门负责人", "secretary", "secretary"},
		{"部门负责人", "", Secretary},
		{"秘书", "a2", Secretary},
		{"用户", "a2", Secretary},
		{"备忘的主人", "a2", Secretary},
		{"技能作者", "a1", Secretary},
		{"加资料的人", "a1", Secretary},
		{"出选项单的人", "a1", Secretary},
	}
	for _, c := range cases {
		if got := AlertTo(c.owner, c.leader); got != c.want {
			t.Errorf("AlertTo(%q, %q) = %q，应为 %q", c.owner, c.leader, got, c.want)
		}
	}
	for _, l := range Limits {
		got := AlertTo(l.Owner, "a1")
		if l.Owner == "部门负责人" {
			if got != "a1" {
				t.Errorf("上限表 %s 满了找部门负责人，应得 a1，得到 %s", l.Key, got)
			}
			continue
		}
		if got != Secretary {
			t.Errorf("上限表 %s 满了找 %s，应得秘书，得到 %s", l.Key, l.Owner, got)
		}
	}
}

func TestPlanNotices(t *testing.T) {
	points := LimitOf("points")
	secrets := LimitOf("secrets")
	counts := []Count{
		{Key: "points", Used: 8, Max: points.Max},
		{Key: "secrets", Used: 20, Max: secrets.Max},
		{Key: "repos", Used: 1, Max: LimitOf("repos").Max},
	}
	emit, clear := PlanNotices("o2", "a2", counts, nil)
	if len(clear) != 0 {
		t.Fatalf("不该清：%v", clear)
	}
	if len(emit) != 2 || emit[0].Target != "a2" || emit[0].Limit.Key != "points" || emit[0].Used != 8 ||
		emit[1].Target != Secretary || emit[1].Limit.Key != "secrets" {
		t.Fatalf("该发要点给负责人、凭据给秘书：%+v", emit)
	}
	if emit[0].EventKey() != "limit:o2:points" {
		t.Fatalf("EventKey = %s", emit[0].EventKey())
	}

	already := map[NoticeRef]struct{}{
		{Scope: "o2", Key: "points"}:  {},
		{Scope: "o2", Key: "secrets"}: {},
	}
	emit, clear = PlanNotices("o2", "a2", counts, already)
	if len(emit) != 0 || len(clear) != 0 {
		t.Fatalf("已提醒且仍满不该动：emit=%+v clear=%v", emit, clear)
	}

	counts[0].Used = 6
	counts[1].Used = 3
	emit, clear = PlanNotices("o2", "a2", counts, already)
	if len(emit) != 0 || !reflect.DeepEqual(clear, []NoticeRef{{Scope: "o2", Key: "points"}, {Scope: "o2", Key: "secrets"}}) {
		t.Fatalf("回落该清：emit=%+v clear=%v", emit, clear)
	}

	delete(already, NoticeRef{Scope: "o2", Key: "points"})
	counts[0].Used = 8
	emit, clear = PlanNotices("o2", "a2", counts, already)
	if len(emit) != 1 || emit[0].Limit.Key != "points" || len(clear) != 1 || clear[0].Key != "secrets" {
		t.Fatalf("回落后再超只发要点：emit=%+v clear=%v", emit, clear)
	}
}

func TestNoticeText(t *testing.T) {
	l := LimitOf("points")
	got := NoticeText(l, "o2", 8)
	if got != "部门 o2 的每部门要点已 8/7 条（满了找部门负责人）："+l.Fix {
		t.Fatalf("NoticeText = %q", got)
	}
	if NoticeNext(l, "o2") != "atrium org show o2" {
		t.Fatalf("NoticeNext = %q", NoticeNext(l, "o2"))
	}
	g := LimitOf("depts")
	if NoticeText(g, "", 500) != "全部部门已 500/500 个（满了找秘书）："+g.Fix {
		t.Fatalf("全局 NoticeText = %q", NoticeText(g, "", 500))
	}
}
