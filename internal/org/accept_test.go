package org

import (
	"context"
	"testing"
)

func TestResolveAcceptor(t *testing.T) {
	// o1 → o2 → o3；o4 顶层。
	ps := map[string]string{"o1": "", "o2": "o1", "o3": "o2", "o4": ""}
	set := map[string]string{"o1": AcceptUser, "o3": AcceptAuto}
	cases := []struct{ dept, who, from string }{
		{"o1", AcceptUser, "o1"},
		{"o2", AcceptUser, "o1"}, // 继承上级
		{"o3", AcceptAuto, "o3"}, // 下级自己设的优先
		{"o4", AcceptAuto, ""},   // 都没设
		{"", AcceptAuto, ""},
	}
	for _, c := range cases {
		if who, from := ResolveAcceptor(ps, set, c.dept); who != c.who || from != c.from {
			t.Errorf("%s: got %s %s", c.dept, who, from)
		}
	}
}

func TestMayAccept(t *testing.T) {
	cases := []struct {
		actor, who string
		ok         bool
	}{
		{"u1", AcceptUser, true},
		{"secretary", AcceptUser, true}, // 秘书替用户执行命令
		{"a1", AcceptUser, false},
		{"a1", AcceptLeader, true},
		{"a1", AcceptAuto, true},
		{"gates", AcceptLeader, false},
	}
	for _, c := range cases {
		if MayAccept(c.actor, c.who) != c.ok {
			t.Errorf("%s 判 %s：应为 %v", c.actor, c.who, c.ok)
		}
	}
}

func TestEditAccept(t *testing.T) {
	db, _ := openDB(t)
	ctx := context.Background()
	top, _ := Add(ctx, db, NewDept{Name: "公司"})
	sub, _ := Add(ctx, db, NewDept{Name: "哆啦美", Parent: top.ID})
	set := func(dept, v string) error {
		_, err := Edit(ctx, db, dept, DeptPatch{Accept: &v})
		return err
	}
	check := func(want, wantFrom string) {
		t.Helper()
		who, from, err := Acceptor(ctx, db, sub.ID)
		if err != nil || who != want || from != wantFrom {
			t.Fatalf("got %s %s %v，want %s %s", who, from, err, want, wantFrom)
		}
	}
	check(AcceptAuto, "")
	if err := set(top.ID, AcceptUser); err != nil {
		t.Fatal(err)
	}
	check(AcceptUser, top.ID)
	if err := set(sub.ID, AcceptLeader); err != nil {
		t.Fatal(err)
	}
	check(AcceptLeader, sub.ID)
	if err := set(sub.ID, "-"); err != nil {
		t.Fatal(err)
	}
	check(AcceptUser, top.ID)
	if err := set(sub.ID, "boss"); err == nil {
		t.Fatal("非法验收人应拒绝")
	}
	if _, err := DeleteDept(ctx, db, top.ID); err == nil {
		t.Fatal("还有下属时应拒绝删")
	}
	if _, err := DeleteDept(ctx, db, sub.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := DeleteDept(ctx, db, top.ID); err != nil {
		t.Fatalf("设了验收人的部门应能删：%v", err)
	}
	var n int
	db.QueryRowContext(ctx, `SELECT count(*) FROM acceptors`).Scan(&n)
	if n != 0 {
		t.Fatalf("删部门应连同验收人设置：还剩 %d", n)
	}
}
