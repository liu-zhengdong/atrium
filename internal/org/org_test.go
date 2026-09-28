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

func TestDepthAndCheckPlace(t *testing.T) {
	// o1 → o2 → o3 → o4；o5 顶层，o6 在 o5 下。
	ps := map[string]string{"o1": "", "o2": "o1", "o3": "o2", "o4": "o3", "o5": "", "o6": "o5"}
	if Depth(ps, "o4") != 4 || Depth(ps, "o1") != 1 {
		t.Fatal("Depth 不对")
	}
	cases := []struct {
		name, id, parent string
		ok               bool
	}{
		{"新建顶层", "", "", true},
		{"新建到第 5 层", "", "o4", true},
		{"挪到自己下面", "o2", "o3", false},
		{"挪到自己", "o2", "o2", false},
		{"两层子树挪到第 4 层下会到第 6 层", "o5", "o4", false},
		{"两层子树挪到第 3 层下正好第 5 层", "o5", "o3", true},
		{"挪到顶层", "o3", "", true},
	}
	for _, c := range cases {
		err := CheckPlace(ps, c.id, c.parent)
		if (err == nil) != c.ok {
			t.Errorf("%s: err=%v", c.name, err)
		}
	}
	ps["o7"] = "o4"
	if CheckPlace(ps, "", "o7") == nil {
		t.Error("第 6 层应拒绝")
	}
}

func TestInsertAt(t *testing.T) {
	cases := []struct {
		order []string
		id    string
		pos   int
		want  []string
		ok    bool
	}{
		{nil, "k1", 0, []string{"k1"}, true},
		{[]string{"k1", "k2"}, "k3", 1, []string{"k3", "k1", "k2"}, true},
		{[]string{"k1", "k2"}, "k3", 3, []string{"k1", "k2", "k3"}, true},
		{[]string{"k1", "k2", "k3"}, "k3", 1, []string{"k3", "k1", "k2"}, true}, // 挪
		{[]string{"k1", "k2", "k3"}, "k1", 3, []string{"k2", "k3", "k1"}, true},
		{[]string{"k1", "k2"}, "k3", 4, nil, false},
		{[]string{"k1", "k2"}, "k1", 3, nil, false}, // 挪时只有 1–2
		{[]string{"k1"}, "k2", -1, nil, false},
	}
	for _, c := range cases {
		got, err := InsertAt(c.order, c.id, c.pos)
		if (err == nil) != c.ok || (c.ok && !reflect.DeepEqual(got, c.want)) {
			t.Errorf("%v %s %d: got %v %v", c.order, c.id, c.pos, got, err)
		}
	}
}

func TestCheckRoom(t *testing.T) {
	if CheckRoom("o1", MaxPoints-1) != nil {
		t.Fatal("没满")
	}
	err := CheckRoom("o1", MaxPoints)
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Code != "limit" || ae.Next == "" || !strings.Contains(ae.Message, "合并") {
		t.Fatalf("满了应告诉怎么办：%v", err)
	}
}

func TestOrgStore(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	root, err := Add(ctx, db, NewDept{Name: "公司", What: "全部", Repos: []string{"a/b"}})
	if err != nil || root.ID != "o1" || !reflect.DeepEqual(root.Repos, []string{"a/b"}) {
		t.Fatalf("%+v %v", root, err)
	}
	sub, _ := Add(ctx, db, NewDept{Name: "运行时", Parent: "o1"})
	if _, err := Add(ctx, db, NewDept{Name: "x", Leader: "u1"}); err == nil {
		t.Fatal("u1 不是负责人，应拒绝")
	}
	if _, err := Add(ctx, db, NewDept{Name: "x", Parent: "o9"}); err == nil {
		t.Fatal("上级不存在应拒绝")
	}
	// 要点：顶层两条，子部门一条；链按顶层 → 子部门。
	k1, _ := AddPoint(ctx, db, "o1", NewPoint{Text: "简洁优先"}, "u1")
	k2, _ := AddPoint(ctx, db, "o1", NewPoint{Text: "事实为准", Pos: 1}, "u1")
	if k1.By != "u1" {
		t.Fatalf("by 缺省为发起人：%+v", k1)
	}
	AddPoint(ctx, db, sub.ID, NewPoint{Text: "单实例"}, "u1")
	chain, err := Chain(ctx, db, sub.ID)
	if err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, p := range chain {
		texts = append(texts, p.Text)
	}
	if !reflect.DeepEqual(texts, []string{"事实为准", "简洁优先", "单实例"}) || chain[0].ID != k2.ID {
		t.Fatalf("链 %v", texts)
	}
	// 挪、删。
	two := 2
	if p, err := EditPoint(ctx, db, k2.ID, PointPatch{Pos: &two}, "u1"); err != nil || p.Pos != 2 {
		t.Fatalf("挪：%+v %v", p, err)
	}
	if _, err := EditPoint(ctx, db, k1.ID, PointPatch{Delete: true}, "u1"); err != nil {
		t.Fatal(err)
	}
	if ps, _ := Points(ctx, db, "o1"); len(ps) != 1 || ps[0].Pos != 1 {
		t.Fatalf("删后重排 %+v", ps)
	}
	// 满 7 条拒绝。
	for i := 0; i < MaxPoints-1; i++ {
		if _, err := AddPoint(ctx, db, "o1", NewPoint{Text: "p"}, "u1"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := AddPoint(ctx, db, "o1", NewPoint{Text: "第八条"}, "u1"); err == nil {
		t.Fatal("第 8 条应拒绝")
	}
	// 挪部门成环拒绝；仓库增删。
	top := "-"
	if _, err := Edit(ctx, db, "o1", DeptPatch{Parent: &sub.ID}); err == nil {
		t.Fatal("成环应拒绝")
	}
	d, err := Edit(ctx, db, sub.ID, DeptPatch{Parent: &top, RepoAdd: []string{"x/y"}})
	if err != nil || d.Parent != "" || !reflect.DeepEqual(d.Repos, []string{"x/y"}) {
		t.Fatalf("%+v %v", d, err)
	}
	if anc, _ := Ancestors(ctx, db, sub.ID); !reflect.DeepEqual(anc, []string{sub.ID}) {
		t.Fatalf("挪到顶层后链 %v", anc)
	}
	forest, _ := Tree(ctx, db)
	if len(forest) != 2 {
		t.Fatalf("森林 %d", len(forest))
	}
}

// 超了上限的（导入的旧数据）读出来不截断：要点链全给，并标出「超限 8/7」。
func TestOverLimitNotTruncated(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	root, _ := Add(ctx, db, NewDept{Name: "公司"})
	sub, _ := Add(ctx, db, NewDept{Name: "运行时", Parent: root.ID})
	for i := 1; i <= MaxPoints+1; i++ { // 绕过 CheckRoom，模拟导入
		if _, err := db.ExecContext(ctx, `INSERT INTO points (id, department, pos, text, decided_by, updated_by, updated_at)
			VALUES (?, ?, ?, ?, 'u1', 'import', 0)`, "k"+string(rune('0'+i)), root.ID, i, "规矩"); err != nil {
			t.Fatal(err)
		}
	}
	chain, err := Chain(ctx, db, sub.ID)
	if err != nil || len(chain) != MaxPoints+1 {
		t.Fatalf("要点链应全给 %d 条：%d %v", MaxPoints+1, len(chain), err)
	}
	if got := PointsOver(chain); !reflect.DeepEqual(got, []string{root.ID + " 要点超限 8/7（全部附上，待整理）"}) {
		t.Fatalf("超限标注：%v", got)
	}
	if Tally("points", 7) != "7/7" || Tally("points", 8) != "超限 8/7" {
		t.Fatal("Tally")
	}
}
