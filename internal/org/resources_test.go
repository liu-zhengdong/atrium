package org

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func code(err error) string {
	var ae *api.Error
	if errors.As(err, &ae) {
		return ae.Code
	}
	if err != nil {
		return "other"
	}
	return ""
}

func TestLimitTable(t *testing.T) {
	seen := map[string]bool{}
	for _, l := range Limits {
		if seen[l.Key] || l.Max <= 0 || l.Owner == "" || l.Fix == "" || l.Next == "" {
			t.Errorf("上限表这一行不完整或重复：%+v", l)
		}
		seen[l.Key] = true
	}
	err := Full("decisions", "o3", 30)
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Code != "limit" || ae.Next != "atrium decision ls --node o3" ||
		!strings.Contains(ae.Message, "30/30") || !strings.Contains(ae.Message, "找用户") {
		t.Fatalf("满了要说几/上限、找谁、怎么办：%+v", ae)
	}
}

func TestSecretName(t *testing.T) {
	for name, ok := range map[string]bool{
		"TELEGRAM_BOT_TOKEN": true, "A": true, "X1_Y": true,
		"": false, "lower": false, "1A": false, "A-B": false, strings.Repeat("A", 65): false,
		"PATH": false, "HOME": false, "HTTPS_PROXY": false, "SYSTEMROOT": false, "ATRIUM_WORKER": false,
		"ATRIUM_X": false, "NODE_OPTIONS": false, "LD_PRELOAD": false, "DYLD_X": false, "GIT_DIR": false,
		"NO_COLOR": false, "PAGER": false, "BASH_ENV": false, "LC_ALL": false,
	} {
		if err := CheckSecretName(name); (err == nil) != ok {
			t.Errorf("%q: %v", name, err)
		}
	}
}

func TestUnitsAndPlan(t *testing.T) {
	if u, bin := Units([]byte("你好ab")); u != 4 || bin {
		t.Fatalf("文本按字：%d %v", u, bin)
	}
	if u, bin := Units([]byte{0, 1, 2, 3}); u != 2 || !bin {
		t.Fatalf("二进制 3 字节一字向上取整：%d %v", u, bin)
	}
	existing := []materialSlot{{id: "m1", kind: "overview", title: "总览.md", units: 1000, rev: 2},
		{id: "m2", kind: "detail", title: "a.md", units: 40000, rev: 1}}
	text := func(n int) []byte { return []byte(strings.Repeat("字", n)) }
	cases := []struct {
		name string
		in   MaterialInput
		want []materialSlot
		code string
	}{
		{"新细节", MaterialInput{Files: []MaterialFile{{"b.md", text(100)}}}, []materialSlot{{kind: "detail", title: "b.md", units: 100}}, ""},
		{"同名细节追加一版", MaterialInput{Files: []MaterialFile{{"a.md", text(48000)}}},
			[]materialSlot{{id: "m2", rev: 1, kind: "detail", title: "a.md", units: 48000}}, ""},
		{"总览换一份也是同一条的新版", MaterialInput{Overview: true, Files: []MaterialFile{{"新总览.md", text(3000)}}},
			[]materialSlot{{id: "m1", rev: 2, kind: "overview", title: "新总览.md", units: 3000}}, ""},
		{"总览超 3000 字", MaterialInput{Overview: true, Files: []MaterialFile{{"o.md", text(3001)}}}, nil, "limit"},
		{"总览不能是二进制", MaterialInput{Overview: true, Files: []MaterialFile{{"o.png", []byte{0, 0}}}}, nil, "usage"},
		{"部门合计超 5 万字", MaterialInput{Files: []MaterialFile{{"c.md", text(9001)}}}, nil, "limit"},
		{"重复文件", MaterialInput{Files: []MaterialFile{{"c.md", text(1)}, {"c.md", text(1)}}}, nil, "usage"},
	}
	for _, c := range cases {
		got, err := PlanMaterials("o1", existing, c.in)
		if code(err) != c.code || (c.code == "" && !reflect.DeepEqual(got, c.want)) {
			t.Errorf("%s：%+v %v", c.name, got, err)
		}
	}
}

func TestSkillPure(t *testing.T) {
	for body, want := range map[string]string{
		"---\nname: x\ndescription: 做网页设计\n---\n# 标题": "做网页设计",
		"# 修 bug 的做法\n\n正文":                           "修 bug 的做法",
		"\n\n  第一行\n":                                 "第一行",
		"":                                            "",
	} {
		if got := SkillSummary(body); got != want {
			t.Errorf("%q → %q，想要 %q", body, got, want)
		}
	}
	for name, ok := range map[string]bool{"web-design": true, "a1": true, "Web": false, "a--b": false, "-a": false, "a/b": false} {
		if (CheckSkillName(name) == nil) != ok {
			t.Errorf("技能名 %q", name)
		}
	}
	cases := []struct {
		files map[string]string
		code  string
	}{
		{map[string]string{"SKILL.md": "x", "refs/a.md": "y"}, ""},
		{map[string]string{"README.md": "x"}, "usage"},
		{map[string]string{"SKILL.md": strings.Repeat("x", MaxSkillBody+1)}, "limit"},
		{map[string]string{"SKILL.md": "x", "../a": "y"}, "usage"},
		{map[string]string{"SKILL.md": "x", ".hidden": "y"}, "usage"},
		{map[string]string{"SKILL.md": "x", "/abs": "y"}, "usage"},
		{map[string]string{"SKILL.md": "x", "a/b/c/d": "y"}, "usage"},
		{map[string]string{"SKILL.md": "x", "bin": "\x00"}, "usage"},
	}
	for _, c := range cases {
		if got := code(CheckSkillFiles(c.files)); got != c.code {
			t.Errorf("%v：%s，想要 %s", c.files, got, c.code)
		}
	}
}

func TestDecisionRoom(t *testing.T) {
	if DecisionRoom("o1", 29, 0) != nil || DecisionRoom("o1", 30, 1) != nil || code(DecisionRoom("o1", 30, 0)) != "limit" {
		t.Fatal("决定上限：合并替换不增加条数")
	}
}

func openDB(t *testing.T) (*store.DB, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db, dir
}

func TestResourcesStore(t *testing.T) {
	db, data := openDB(t)
	ctx := context.Background()
	root, _ := Add(ctx, db, NewDept{Name: "公司"})
	sub, _ := Add(ctx, db, NewDept{Name: "运行时", Parent: root.ID})
	other, _ := Add(ctx, db, NewDept{Name: "别的"})

	// 技能：建、只改元数据沿用文件、超过保留版数时删最旧的。
	k, err := SaveSkill(ctx, db, data, SkillInput{Name: "fix-bug", Files: map[string]string{"SKILL.md": "# 修 bug\n先复现", "refs/x.md": "附"}}, "u1")
	if err != nil || k.Rev != 1 || k.Summary != "修 bug" || k.Files != 2 {
		t.Fatalf("%+v %v", k, err)
	}
	w := []string{"claude"}
	k, err = SaveSkill(ctx, db, data, SkillInput{Name: "fix-bug", Workers: &w}, "u1")
	if err != nil || k.Rev != 2 || !reflect.DeepEqual(k.Workers, w) {
		t.Fatalf("%+v %v", k, err)
	}
	if raw, err := os.ReadFile(filepath.Join(filepath.Dir(k.Path), "refs", "x.md")); err != nil || string(raw) != "附" {
		t.Fatalf("附属文件沿用：%q %v", raw, err)
	}
	if code(func() error { _, err := SaveSkill(ctx, db, data, SkillInput{Name: "fix-bug"}, "u1"); return err }()) != "usage" {
		t.Fatal("没有要改的应拒绝")
	}
	for i := 0; i < keepSkillRevs; i++ {
		if _, err := SaveSkill(ctx, db, data, SkillInput{Name: "fix-bug", Files: map[string]string{"SKILL.md": "v"}}, "u1"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(skillDir(data, "fix-bug", 2)); !os.IsNotExist(err) {
		t.Fatal("超过保留版数的旧目录应删掉")
	}
	if paths, err := SkillPaths(ctx, db, data, "fix-bug"); err != nil || len(paths) != 1 || !strings.HasSuffix(paths[0], filepath.Join("r12", "SKILL.md")) {
		t.Fatalf("派活路径：%v %v", paths, err)
	}
	if _, err := SkillPaths(ctx, db, data, "nope"); code(err) != "not_found" {
		t.Fatal("没有的技能派活应报错")
	}

	// 资料：总览、细节、同名追加一版、归档不算用量、撤销归档查上限。
	ms, err := AddMaterials(ctx, db, data, MaterialInput{Org: sub.ID, Overview: true, Note: "总览", Files: []MaterialFile{{"总览.md", []byte("是什么")}}}, "u1")
	if err != nil || ms[0].Kind != "overview" || ms[0].Units != 3 {
		t.Fatalf("%+v %v", ms, err)
	}
	if ov, err := Overview(ctx, db, data, sub.ID); err != nil || ov != "是什么" {
		t.Fatalf("总览：%q %v", ov, err)
	}
	d1, _ := AddMaterials(ctx, db, data, MaterialInput{Org: sub.ID, Note: "细节", Files: []MaterialFile{{"a.md", []byte("1")}}}, "u1")
	d2, err := AddMaterials(ctx, db, data, MaterialInput{Org: sub.ID, Note: "改", Files: []MaterialFile{{"a.md", []byte(strings.Repeat("字", 46000))}}}, "u1")
	if err != nil || d2[0].ID != d1[0].ID || d2[0].Rev != 2 {
		t.Fatalf("同名追加一版：%+v %v", d2, err)
	}
	if old, err := GetMaterial(ctx, db, data, d1[0].ID, 1); err != nil || old.Units != 1 {
		t.Fatalf("旧版还在：%+v %v", old, err)
	}
	if _, err := AddMaterials(ctx, db, data, MaterialInput{Org: sub.ID, Note: "x", Files: []MaterialFile{{"b.md", []byte(strings.Repeat("字", 4000))}}}, "u1"); code(err) != "limit" {
		t.Fatalf("超总量应拒绝：%v", err)
	}
	if _, err := ArchiveMaterial(ctx, db, data, d1[0].ID, false); err != nil {
		t.Fatal(err)
	}
	b, err := AddMaterials(ctx, db, data, MaterialInput{Org: sub.ID, Note: "x", Files: []MaterialFile{{"b.md", []byte(strings.Repeat("字", 4000))}}}, "u1")
	if err != nil {
		t.Fatalf("归档后腾出地方：%v", err)
	}
	_ = b
	if _, err := ArchiveMaterial(ctx, db, data, d1[0].ID, true); code(err) != "limit" {
		t.Fatalf("撤销归档超总量应拒绝：%v", err)
	}

	// 决定：推翻后不算有效；满 30 拒绝；合并可在满时写入。
	tx, _ := db.Begin()
	d, err := AddDecision(ctx, tx, NewDecision{Org: sub.ID, Text: "先做 A", Why: "快"}, "u1")
	tx.Commit()
	if err != nil || d.ID != "d1" {
		t.Fatalf("%+v %v", d, err)
	}
	add := func(in NewDecision) (Decision, error) {
		var out Decision
		err := db.Tx(ctx, func(tx *sql.Tx) error {
			var err error
			out, err = AddDecision(ctx, tx, in, "u1")
			return err
		})
		return out, err
	}
	d2x, err := add(NewDecision{Org: sub.ID, Text: "改做 B", Replaces: []string{"d1"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := add(NewDecision{Org: sub.ID, Text: "再推翻 d1", Replaces: []string{"d1"}}); code(err) != "conflict" {
		t.Fatal("已推翻的不能再推翻")
	}
	if _, err := add(NewDecision{Org: other.ID, Text: "x", Replaces: []string{d2x.ID}}); code(err) != "usage" {
		t.Fatal("不能推翻别的部门的")
	}
	for i := 1; i < MaxDecisions; i++ {
		if _, err := add(NewDecision{Org: sub.ID, Text: "d"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := add(NewDecision{Org: sub.ID, Text: "第 31 条"}); code(err) != "limit" {
		t.Fatalf("第 31 条应拒绝：%v", err)
	}
	if _, err := add(NewDecision{Org: sub.ID, Text: "合并", Replaces: []string{d2x.ID, "d3"}}); err != nil {
		t.Fatalf("合并两条应可写：%v", err)
	}
	if list, _ := Decisions(ctx, db, DecisionFilter{Org: sub.ID, Keyword: "B", All: true}); len(list) != 1 || list[0].SupersededBy == "" {
		t.Fatalf("关键词查已推翻的：%+v", list)
	}
	if list, _ := Decisions(ctx, db, DecisionFilter{Org: sub.ID, Keyword: "B"}); len(list) != 0 {
		t.Fatalf("缺省不含已推翻的：%+v", list)
	}

	// 凭据：文件 0600、往上找、近的盖远的、找不到带修正命令。
	if _, err := SetSecret(ctx, db, data, root.ID, "BOT_TOKEN", []byte("root-v\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := SetSecret(ctx, db, data, sub.ID, "API_KEY_X", []byte("sub-v")); err != nil {
		t.Fatal(err)
	}
	if _, err := SetSecret(ctx, db, data, sub.ID, "PATH", []byte("x")); code(err) != "usage" {
		t.Fatal("系统变量名应拒绝")
	}
	if runtime.GOOS != "windows" {
		if st, _ := os.Stat(secretFile(data, root.ID, "BOT_TOKEN")); st.Mode().Perm() != 0o600 {
			t.Fatalf("凭据文件权限 %v", st.Mode().Perm())
		}
	}
	env, err := SecretEnv(ctx, db, data, sub.ID, []string{"BOT_TOKEN", "API_KEY_X"})
	if err != nil || env["BOT_TOKEN"] != "root-v" || env["API_KEY_X"] != "sub-v" {
		t.Fatalf("%v %v", env, err)
	}
	if _, err := SecretEnv(ctx, db, data, other.ID, []string{"API_KEY_X"}); code(err) != "not_found" {
		t.Fatal("别的部门找不到下属的凭据")
	}
	if list, _ := Secrets(ctx, db, sub.ID); len(list) != 2 || list[0].LastUsedAt == nil {
		t.Fatalf("清单含上级的、记下使用时间：%+v", list)
	}
	if _, err := RemoveSecret(ctx, db, data, root.ID, "BOT_TOKEN"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(secretFile(data, root.ID, "BOT_TOKEN")); !os.IsNotExist(err) {
		t.Fatal("删后文件还在")
	}

	// 计数。
	counts, err := Counts(ctx, db, sub.ID)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for _, c := range counts {
		got[c.Key] = c.Used
	}
	if got["decisions"] != MaxDecisions-1 || got["secrets"] != 1 || got["overview"] != 3 || got["materials"] != 3+4000 {
		t.Fatalf("计数 %v", got)
	}
	if g, _ := Counts(ctx, db, ""); g[1].Key != "skills" || g[1].Used != 1 {
		t.Fatalf("全局计数 %+v", g)
	}
}
