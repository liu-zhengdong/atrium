package org

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// o1 → o2 → o3；o4 顶层。a1 管 o1，a2 管 o3。
var tps = map[string]string{"o1": "", "o2": "o1", "o3": "o2", "o4": ""}
var tls = map[string]string{"o1": "a1", "o3": "a2"}

func TestNearest(t *testing.T) {
	cases := []struct{ dept, skip, want, from string }{
		{"o3", "", "a2", "o3"},
		{"o2", "", "a1", "o1"},      // 本部门没有，往上找
		{"o3", "a2", "a1", "o1"},    // 上交跳过自己
		{"o1", "a1", Secretary, ""}, // 顶层还是自己：投秘书
		{"o4", "", Secretary, ""},
		{"", "", Secretary, ""},
		{"o9", "", Secretary, ""}, // 不存在的部门
	}
	for _, c := range cases {
		if got, from := Nearest(tps, tls, c.dept, c.skip); got != c.want || from != c.from {
			t.Errorf("Nearest(%s, skip %s) = %s（%s），应为 %s（%s）", c.dept, c.skip, got, from, c.want, c.from)
		}
	}
}

func TestCovered(t *testing.T) {
	for dept, want := range map[string][]string{"o1": {"o2"}, "o3": {}, "o4": {}} {
		if got := Covered(tps, tls, dept); !reflect.DeepEqual(got, want) {
			t.Errorf("Covered(%s) = %v，应为 %v", dept, got, want)
		}
	}
}

func TestScopeAndLed(t *testing.T) {
	keys := func(m map[string]bool) []string {
		var out []string
		for _, k := range []string{"o1", "o2", "o3", "o4"} {
			if m[k] {
				out = append(out, k)
			}
		}
		return out
	}
	if got := keys(Scope(tps, tls, "a1")); !reflect.DeepEqual(got, []string{"o1", "o2", "o3"}) {
		t.Errorf("a1 管辖：%v", got)
	}
	if got := keys(Scope(tps, tls, "a2")); !reflect.DeepEqual(got, []string{"o3"}) {
		t.Errorf("a2 管辖：%v", got)
	}
	if got := keys(Scope(tps, tls, "a9")); got != nil {
		t.Errorf("没负责部门的管辖应为空：%v", got)
	}
	if got := Led(map[string]string{"o10": "a1", "o2": "a1", "o3": "a2"}, "a1"); !reflect.DeepEqual(got, []string{"o2", "o10"}) {
		t.Errorf("Led 按数字排：%v", got)
	}
}

func TestMemoOwner(t *testing.T) {
	user := api.Actor{ID: "u1", Kind: "user"}
	lead := api.Actor{ID: "a2", Kind: "leader"}
	cases := []struct {
		actor api.Actor
		as    string
		want  string
		ok    bool
	}{
		{user, "", Secretary, true},
		{user, "a3", "a3", true},
		{user, "secretary", Secretary, true},
		{user, "u1", "", false},
		{user, "../x", "", false},
		{lead, "", "a2", true},
		{lead, "a2", "a2", true},
		{lead, "a3", "", false},
		{lead, "secretary", "", false},
		{api.Actor{ID: "h2", Kind: "host"}, "", "", false},
	}
	for _, c := range cases {
		got, err := MemoOwner(c.actor, c.as)
		if (err == nil) != c.ok || got != c.want {
			t.Errorf("MemoOwner(%v, %q) = %q, %v", c.actor, c.as, got, err)
		}
	}
	if CheckMemo("a1", strings.Repeat("字", MaxMemo)) != nil {
		t.Error("正好上限应放行")
	}
	var ae *api.Error
	if err := CheckMemo("a1", strings.Repeat("字", MaxMemo+1)); !errors.As(err, &ae) || ae.Code != "limit" || !strings.Contains(ae.Message, "精简") && !strings.Contains(ae.Message, "删掉") {
		t.Errorf("超上限应拒绝并提示精简：%v", err)
	}
}

func TestIdentityStore(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	for _, bad := range []NewLeader{{Name: "", Workers: []string{"c"}}, {Name: "x"}, {Name: "x", Workers: []string{"a", "a"}},
		{Name: "x", Workers: []string{"a,b"}}, {Name: "x", Workers: []string{"1", "2", "3", "4", "5", "6"}}} {
		if _, err := AddLeader(ctx, db, bad); err == nil {
			t.Errorf("应拒绝 %+v", bad)
		}
	}
	a1, err := AddLeader(ctx, db, NewLeader{Name: "运行时", Workers: []string{"claude", "codex"}})
	if err != nil || a1.ID != "a1" || !reflect.DeepEqual(a1.Workers, []string{"claude", "codex"}) || len(a1.Depts) != 0 {
		t.Fatalf("%+v %v", a1, err)
	}
	root, _ := Add(ctx, db, NewDept{Name: "公司"})
	sub, _ := Add(ctx, db, NewDept{Name: "运行时", Parent: root.ID, Leader: a1.ID})
	if got, _ := Recipient(ctx, db, sub.ID); got != "a1" {
		t.Errorf("子部门的事件投 a1：%s", got)
	}
	if got, _ := Recipient(ctx, db, root.ID); got != Secretary {
		t.Errorf("顶层没负责人投秘书：%s", got)
	}
	w := []string{"codex"}
	a1, err = EditLeader(ctx, db, "a1", LeaderPatch{Workers: &w})
	if err != nil || !reflect.DeepEqual(a1.Workers, w) || !reflect.DeepEqual(a1.Depts, []string{sub.ID}) {
		t.Fatalf("%+v %v", a1, err)
	}
	if _, err := EditLeader(ctx, db, "secretary", LeaderPatch{Workers: &w}); err == nil {
		t.Error("秘书不是负责人，不能 edit")
	}
	list, _ := Leaders(ctx, db)
	if len(list) != 1 || list[0].ID != "a1" {
		t.Fatalf("%+v", list)
	}
	// 备忘：覆盖写，超上限拒绝且不改原文。
	if m, _ := GetMemo(ctx, db, "a1"); m.Body != "" {
		t.Fatal("新负责人备忘应为空")
	}
	SetMemo(ctx, db, "a1", "第一版", "a1")
	if m, err := SetMemo(ctx, db, "a1", "第二版", "u1"); err != nil || m.Body != "第二版" || m.UpdatedBy != "u1" {
		t.Fatalf("%+v %v", m, err)
	}
	if _, err := SetMemo(ctx, db, "a1", strings.Repeat("x", MaxMemo+1), "a1"); err == nil {
		t.Fatal("超上限应拒绝")
	}
	if m, _ := GetMemo(ctx, db, "a1"); m.Body != "第二版" {
		t.Fatal("拒绝后原文不变")
	}
	if _, err := SetMemo(ctx, db, "a9", "x", "u1"); err == nil {
		t.Fatal("不存在的身份应拒绝")
	}
}

func TestInheritedLine(t *testing.T) {
	cases := []struct{ who, from, want string }{
		{"a1", "o3", "负责人：a1\n"},
		{"a1", "o1", "负责人：a1（继承自 o1）\n"},
		{Secretary, "", "负责人：secretary（归秘书）\n"},
	}
	for _, c := range cases {
		var b strings.Builder
		inherited(&b, "负责人", c.who, c.from, "o3", "归秘书")
		if b.String() != c.want {
			t.Errorf("inherited(%s, %s) = %q，应为 %q", c.who, c.from, b.String(), c.want)
		}
	}
}
