package org

import (
	"context"
	"strings"
	"testing"
)

func TestCheckDelete(t *testing.T) {
	cases := []struct {
		name string
		refs []Refs
		want []string // 报错里要有的片段；nil 表示放行
	}{
		{"没有引用", nil, nil},
		{"引用都是 0", []Refs{{What: "任务", Fix: "x"}, {What: "资料", Fix: "y"}}, nil},
		{"一类引用", []Refs{{What: "任务", N: 2, IDs: []string{"t1", "t2"}, Fix: "改归属"}},
			[]string{"o9 还有引用", "任务 2（t1、t2）：改归属"}},
		{"多了只列前几个", []Refs{{What: "任务", N: 7, IDs: []string{"t1", "t2"}, Fix: "f"}}, []string{"任务 7（t1、t2…）"}},
		{"多类只列非 0 的", []Refs{{What: "下属部门", N: 1, IDs: []string{"o3"}, Fix: "挪"}, {What: "资料", Fix: "-"},
			{What: "凭据", N: 1, IDs: []string{"GH_TOKEN"}, Fix: "删"}}, []string{"下属部门 1（o3）", "凭据 1（GH_TOKEN）"}},
	}
	for _, c := range cases {
		err := CheckDelete("o9", c.refs)
		if c.want == nil {
			if err != nil {
				t.Errorf("%s：应放行，得 %v", c.name, err)
			}
			continue
		}
		if code(err) != "conflict" {
			t.Errorf("%s：应 conflict，得 %v", c.name, err)
			continue
		}
		for _, w := range c.want {
			if !strings.Contains(err.Error(), w) {
				t.Errorf("%s：报错缺 %q：\n%s", c.name, w, err)
			}
		}
		if strings.Contains(err.Error(), "资料") {
			t.Errorf("%s：0 条的不该列：\n%s", c.name, err)
		}
	}
}

func TestDeleteStore(t *testing.T) {
	db, data := openDB(t)
	ctx := context.Background()
	a1, err := AddLeader(ctx, db, NewLeader{Name: "产品", Workers: []string{"claude"}})
	if err != nil {
		t.Fatal(err)
	}
	root, _ := Add(ctx, db, NewDept{Name: "公司"})
	prod, _ := Add(ctx, db, NewDept{Name: "产品部", Parent: root.ID, Leader: a1.ID, Repos: []string{"x/y"}})
	sub, _ := Add(ctx, db, NewDept{Name: "产品子部", Parent: prod.ID})
	if _, err := AddPoint(ctx, db, prod.ID, NewPoint{Text: "先想清楚"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if _, err := SetSecret(ctx, db, data, prod.ID, "GH_TOKEN", []byte("v")); err != nil {
		t.Fatal(err)
	}
	SetMemo(ctx, db, a1.ID, "记一笔", a1.ID)
	db.Exec(`INSERT INTO events (at, updated_at, kind, level, department, target) VALUES (1, 1, 'x', 'info', ?, 'secretary')`, prod.ID)
	db.Exec(`INSERT INTO events (at, updated_at, kind, level, department, target, acked_at) VALUES (1, 1, 'x', 'info', ?, ?, 2)`, prod.ID, a1.ID)
	db.Exec(`INSERT INTO pauses (scope, by, at) VALUES (?, 'u1', 1)`, prod.ID)

	// 有下属、凭据、没确认的事件：拒绝并逐类列出，什么都不动。
	_, err = Edit(ctx, db, prod.ID, DeptPatch{Delete: true})
	if code(err) != "conflict" {
		t.Fatalf("有引用应拒绝：%v", err)
	}
	for _, w := range []string{"下属部门 1（" + sub.ID + "）", "凭据 1（GH_TOKEN）", "没确认的事件 1"} {
		if !strings.Contains(err.Error(), w) {
			t.Errorf("报错缺 %q：\n%s", w, err)
		}
	}
	if _, err := Get(ctx, db, prod.ID); err != nil {
		t.Fatal("拒绝后部门应还在")
	}
	name := "x"
	if code(func() error { _, err := Edit(ctx, db, prod.ID, DeptPatch{Delete: true, Name: &name}); return err }()) != "usage" {
		t.Error("--delete 与别的字段一起给应拒绝")
	}

	// 负责人还负责部门：拒绝。
	if _, err := EditLeader(ctx, db, a1.ID, LeaderPatch{Delete: true}); code(err) != "conflict" || !strings.Contains(err.Error(), "负责的部门 1（"+prod.ID+"）") {
		t.Fatalf("还负责部门应拒绝：%v", err)
	}

	// 腾开：下属删掉、凭据删掉、事件确认。
	if _, err := Edit(ctx, db, sub.ID, DeptPatch{Delete: true}); err != nil {
		t.Fatalf("空的子部门直接删：%v", err)
	}
	if _, err := RemoveSecret(ctx, db, data, prod.ID, "GH_TOKEN"); err != nil {
		t.Fatal(err)
	}
	db.Exec(`UPDATE events SET acked_at = 3 WHERE department = ?`, prod.ID)
	d, err := Edit(ctx, db, prod.ID, DeptPatch{Delete: true})
	if err != nil || d.ID != prod.ID || d.Name != "产品部" {
		t.Fatalf("腾开后应能删：%+v %v", d, err)
	}
	var n int
	db.QueryRow(`SELECT (SELECT count(*) FROM departments WHERE id = ?) + (SELECT count(*) FROM points WHERE department = ?)
		+ (SELECT count(*) FROM department_repos WHERE department = ?) + (SELECT count(*) FROM pauses WHERE scope = ?)
		+ (SELECT count(*) FROM events WHERE department = ?)`, prod.ID, prod.ID, prod.ID, prod.ID, prod.ID).Scan(&n)
	if n != 0 {
		t.Errorf("部门、要点、仓库、暂停、事件上的部门标记应都清掉，剩 %d", n)
	}
	db.QueryRow(`SELECT count(*) FROM events`).Scan(&n)
	if n != 2 {
		t.Errorf("事件本身留着：%d", n)
	}

	// 部门删了，负责人不再负责部门；还有没确认的事件时拒绝，确认后连同备忘删掉。
	db.Exec(`UPDATE events SET acked_at = NULL WHERE target = ?`, a1.ID)
	if _, err := EditLeader(ctx, db, a1.ID, LeaderPatch{Delete: true}); code(err) != "conflict" || !strings.Contains(err.Error(), "没确认的事件 1") {
		t.Fatalf("有没确认的事件应拒绝：%v", err)
	}
	db.Exec(`UPDATE events SET acked_at = 4 WHERE target = ?`, a1.ID)
	if i, err := EditLeader(ctx, db, a1.ID, LeaderPatch{Delete: true}); err != nil || i.ID != a1.ID {
		t.Fatalf("应能删：%+v %v", i, err)
	}
	db.QueryRow(`SELECT (SELECT count(*) FROM identities WHERE id = ?) + (SELECT count(*) FROM memos WHERE identity = ?)`, a1.ID, a1.ID).Scan(&n)
	if n != 0 {
		t.Errorf("负责人与备忘应删掉，剩 %d", n)
	}
	if _, err := EditLeader(ctx, db, "secretary", LeaderPatch{Delete: true}); code(err) != "usage" {
		t.Errorf("秘书不能删：%v", err)
	}
	if _, err := Edit(ctx, db, "o99", DeptPatch{Delete: true}); code(err) != "not_found" {
		t.Errorf("不存在的部门：%v", err)
	}
}
