package org

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
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
	_, err = DeleteDept(ctx, db, prod.ID, DeptPatch{})
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
	if code(func() error { _, err := DeleteDept(ctx, db, prod.ID, DeptPatch{Name: &name}); return err }()) != "usage" {
		t.Error("--delete 与别的字段一起给应拒绝")
	}

	// 负责人还负责部门：拒绝。
	if _, err := EditLeader(ctx, db, a1.ID, LeaderPatch{Delete: true}); code(err) != "conflict" || !strings.Contains(err.Error(), "负责的部门 1（"+prod.ID+"）") {
		t.Fatalf("还负责部门应拒绝：%v", err)
	}

	// 腾开：下属删掉、凭据删掉、事件确认。
	if _, err := DeleteDept(ctx, db, sub.ID, DeptPatch{}); err != nil {
		t.Fatalf("空的子部门直接删：%v", err)
	}
	if _, err := RemoveSecret(ctx, db, data, prod.ID, "GH_TOKEN"); err != nil {
		t.Fatal(err)
	}
	db.Exec(`UPDATE events SET acked_at = 3 WHERE department = ?`, prod.ID)
	d, err := DeleteDept(ctx, db, prod.ID, DeptPatch{})
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
	if _, err := DeleteDept(ctx, db, "o99", DeptPatch{}); code(err) != "not_found" {
		t.Errorf("不存在的部门：%v", err)
	}
}

func TestCheckInto(t *testing.T) {
	// o1 ─ o2 ─ o3 ─ o4；o1 ─ o5。
	ps := map[string]string{"o1": "", "o2": "o1", "o3": "o2", "o4": "o3", "o5": "o1"}
	cases := []struct {
		name, id, into, code string
	}{
		{"并入上级", "o3", "o2", ""},
		{"并入别的部门", "o2", "o5", ""},
		{"并到别的分支深处", "o5", "o4", ""},
		{"自己", "o2", "o2", "usage"},
		{"下属", "o2", "o4", "usage"},
		{"不存在", "o2", "o9", "not_found"},
	}
	for _, c := range cases {
		if got := code(CheckInto(ps, c.id, c.into)); got != c.code {
			t.Errorf("%s：%s 并入 %s 得 %q，想要 %q", c.name, c.id, c.into, got, c.code)
		}
	}
	// 下属挪过去超过 MaxDepth：o10 下面还有 3 层，并入第 4 层的 o4 会到第 7 层。
	deep := map[string]string{"o1": "", "o2": "o1", "o3": "o2", "o4": "o3", "o10": "", "o11": "o10", "o12": "o11", "o13": "o12"}
	if got := code(CheckInto(deep, "o10", "o4")); got != "limit" {
		t.Errorf("超过树深应 limit，得 %q", got)
	}
}

// 并入：挡着的几类逐个拒绝、什么都不动；腾开后同一事务里挪到目标再删，回执列出几条什么。
func TestDeleteInto(t *testing.T) {
	db, data := openDB(t)
	ctx := context.Background()
	root, _ := Add(ctx, db, NewDept{Name: "公司"})
	a, _ := Add(ctx, db, NewDept{Name: "甲部", Parent: root.ID, Repos: []string{"x/y"}})
	b, _ := Add(ctx, db, NewDept{Name: "乙部", Parent: root.ID})
	sub, _ := Add(ctx, db, NewDept{Name: "甲子部", Parent: a.ID})
	if _, err := AddPoint(ctx, db, a.ID, NewPoint{Text: "先想清楚"}, "u1"); err != nil {
		t.Fatal(err)
	}
	accept := "user"
	if _, err := Edit(ctx, db, a.ID, DeptPatch{Accept: &accept}); err != nil {
		t.Fatal(err)
	}
	material := func(dept, name string, overview bool) Material {
		t.Helper()
		m, err := AddMaterial(ctx, db, data, MaterialInput{Org: dept, Files: []MaterialFile{{Name: name, Content: []byte("内容")}}, Overview: overview, Note: "测试用"}, "u1")
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	aOverview, aDetail, bOverview := material(a.ID, "总览.md", true), material(a.ID, "细节.md", false), material(b.ID, "总览.md", true)
	for _, s := range []string{
		`INSERT INTO tasks (id, department, title, status, created_at, updated_at) VALUES ('t901', ?1, '做完的', 'done', 1, 1)`,
		`INSERT INTO tasks (id, department, title, status, created_at, updated_at) VALUES ('t902', ?1, '在跑的', 'running', 1, 1)`,
		`INSERT INTO schedules (id, department, kind, every_ms, title, next_at, created_by, created_at) VALUES ('s901', ?1, 'task', 1, '每天', 1, 'u1', 1)`,
		`INSERT INTO choices (id, department, title, recommend, reason, status, created_by, created_at) VALUES ('c901', ?1, '拍过的', '1', 'r', 'picked', 'u1', 1)`,
		`INSERT INTO choices (id, department, title, recommend, reason, status, created_by, created_at) VALUES ('c902', ?1, '没拍的', '1', 'r', 'open', 'u1', 1)`,
		`INSERT INTO choices (id, department, title, recommend, reason, status, created_by, created_at) VALUES ('c903', ?2, '乙的', '1', 'r', 'picked', 'u1', 1)`,
		`INSERT INTO choice_option_orgs (choice, pos, department) VALUES ('c903', 2, ?1)`,
		`INSERT INTO events (at, updated_at, kind, level, department, target) VALUES (1, 1, 'x', 'info', ?1, 'secretary')`,
		`INSERT INTO pauses (scope, by, at) VALUES (?1, 'u1', 1)`,
		`INSERT INTO limit_notices (scope, key, used, at) VALUES (?1, 'points', 7, 1)`,
	} {
		if _, err := db.Exec(s, a.ID, b.ID); err != nil {
			t.Fatalf("%s：%v", s, err)
		}
	}
	into := func(id string) DeptPatch { return DeptPatch{Into: &id} }

	// 不写 --into：能挪的也挡着，报错指向并入上级。
	_, err := DeleteDept(ctx, db, a.ID, DeptPatch{})
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Code != "conflict" || ae.Next != "atrium org edit "+a.ID+" --delete --into "+root.ID {
		t.Fatalf("不写 --into 应拒绝并给并入上级的命令：%v", err)
	}
	for _, w := range []string{"下属部门 1（" + sub.ID + "）：加 --into 并入时一并挪过去", "任务 1（t901）", "进行中的任务 1（t902）",
		"待拍板的选项单 1（c902）", "资料 2", "并入上级 " + root.ID} {
		if !strings.Contains(err.Error(), w) {
			t.Errorf("报错缺 %q：\n%s", w, err)
		}
	}
	// --into 指向自己、下属、不存在的部门。
	for _, c := range []struct{ into, code string }{{a.ID, "usage"}, {sub.ID, "usage"}, {"o99", "not_found"}} {
		if _, err := DeleteDept(ctx, db, a.ID, into(c.into)); code(err) != c.code {
			t.Errorf("--into %s 应 %s，得 %v", c.into, c.code, err)
		}
	}
	// 带 --into 仍挡着的：进行中的任务、待拍板的选项单、没确认的事件，逐个腾开。
	for _, step := range []struct{ want, fix string }{
		{"进行中的任务 1（t902）", `UPDATE tasks SET status = 'blocked' WHERE id = 't902'`},
		{"待拍板的选项单 1（c902）", `UPDATE choices SET status = 'passed' WHERE id = 'c902'`},
		{"没确认的事件 1", `UPDATE events SET acked_at = 2`},
	} {
		_, err := DeleteDept(ctx, db, a.ID, into(root.ID))
		if code(err) != "conflict" || !strings.Contains(err.Error(), step.want) {
			t.Fatalf("应挡在 %q：%v", step.want, err)
		}
		if strings.Contains(err.Error(), "下属部门") || strings.Contains(err.Error(), "资料") {
			t.Errorf("带 --into 时能挪的不该列：\n%s", err)
		}
		if _, err := Get(ctx, db, a.ID); err != nil {
			t.Fatal("拒绝后部门应还在")
		}
		if _, err := db.Exec(step.fix); err != nil {
			t.Fatal(err)
		}
	}

	// 腾开后并入上级。
	r, err := DeleteDept(ctx, db, a.ID, into(root.ID))
	if err != nil {
		t.Fatal(err)
	}
	want := []Moved{{"下属部门", 1}, {"任务", 2}, {"周期任务", 1}, {"已拍板的选项单", 2}, {"选项单里归它的选项", 1}, {"资料", 2}}
	if r.ID != a.ID || r.Into != root.ID || !reflect.DeepEqual(r.Moved, want) {
		t.Errorf("回执：%+v", r)
	}
	if line := removedLine(r); !strings.Contains(line, "并入 "+root.ID+"：下属部门 1、任务 2、周期任务 1") {
		t.Errorf("回执一行：%s", line)
	}
	var n int
	db.QueryRow(`SELECT (SELECT count(*) FROM departments WHERE id = ?1 OR parent = ?1) + (SELECT count(*) FROM tasks WHERE department = ?1)
		+ (SELECT count(*) FROM schedules WHERE department = ?1) + (SELECT count(*) FROM choices WHERE department = ?1)
		+ (SELECT count(*) FROM choice_option_orgs WHERE department = ?1) + (SELECT count(*) FROM materials WHERE department = ?1)
		+ (SELECT count(*) FROM points WHERE department = ?1) + (SELECT count(*) FROM department_repos WHERE department = ?1)
		+ (SELECT count(*) FROM acceptors WHERE department = ?1) + (SELECT count(*) FROM pauses WHERE scope = ?1)
		+ (SELECT count(*) FROM limit_notices WHERE scope = ?1) + (SELECT count(*) FROM events WHERE department = ?1)`, a.ID).Scan(&n)
	if n != 0 {
		t.Errorf("%s 不该再有引用，剩 %d", a.ID, n)
	}
	if d, _ := Get(ctx, db, sub.ID); d.Parent != root.ID {
		t.Errorf("下属应挂到 %s：%+v", root.ID, d)
	}
	db.QueryRow(`SELECT count(*) FROM tasks WHERE department = ?`, root.ID).Scan(&n)
	if n != 2 {
		t.Errorf("任务应挪到 %s：%d", root.ID, n)
	}
	for _, m := range []Material{aOverview, aDetail} {
		got, err := GetMaterial(ctx, db, data, m.ID, 0)
		if err != nil || got.Org != root.ID || got.Kind != "detail" {
			t.Errorf("资料 %s 应挪到 %s 且是细节：%+v %v", m.ID, root.ID, got, err)
		}
	}

	// 显式 --into 并到别的部门；原总览改作细节，目标部门自己的总览不变。
	c, _ := Add(ctx, db, NewDept{Name: "丙部", Parent: root.ID})
	cOverview := material(c.ID, "丙总览.md", true)
	if r, err := DeleteDept(ctx, db, c.ID, into(b.ID)); err != nil || !reflect.DeepEqual(r.Moved, []Moved{{"资料", 1}}) {
		t.Fatalf("并入 %s：%+v %v", b.ID, r, err)
	}
	if got, _ := GetMaterial(ctx, db, data, cOverview.ID, 0); got.Org != b.ID || got.Kind != "detail" {
		t.Errorf("丙的总览应在乙、改作细节：%+v", got)
	}
	if got, _ := GetMaterial(ctx, db, data, bOverview.ID, 0); got.Kind != "overview" {
		t.Errorf("乙自己的总览不变：%+v", got)
	}
	// 没有引用的部门带 --into：直接删，回执说没有要并入的。
	e, _ := Add(ctx, db, NewDept{Name: "丁部", Parent: root.ID})
	if r, err := DeleteDept(ctx, db, e.ID, into(b.ID)); err != nil || len(r.Moved) != 0 || !strings.Contains(removedLine(r), "没有要并入") {
		t.Errorf("空部门并入：%+v %v", r, err)
	}

	// 顶层部门不写 --into：说明没有上级、要写明并入哪个部门。
	_, err = DeleteDept(ctx, db, root.ID, DeptPatch{})
	if !errors.As(err, &ae) || ae.Next != "atrium org edit "+root.ID+" --delete --into <oM>" || !strings.Contains(err.Error(), "顶层部门") {
		t.Errorf("顶层不写 --into：%v", err)
	}
	// --into 只和 --delete 一起给。
	if _, err := Edit(ctx, db, b.ID, into(root.ID)); code(err) != "usage" {
		t.Errorf("--into 不带 --delete 应拒绝：%v", err)
	}
}
