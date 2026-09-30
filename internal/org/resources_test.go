package org

import (
	"context"
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
	err := Full("secrets", "o3", 20)
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Code != "limit" || ae.Next != "atrium secret ls --node o3" ||
		!strings.Contains(ae.Message, "20/20") || !strings.Contains(ae.Message, "找用户") {
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
	if u, bin := Units([]byte{0, 1, 2, 3}); u != 0 || !bin {
		t.Fatalf("二进制不折算字数：%d %v", u, bin)
	}
	existing := []materialSlot{{id: "m1", kind: "overview", title: "总览.md", units: 1000, rev: 2},
		{id: "m2", kind: "detail", title: "a.md", units: 40000, rev: 1},
		{id: "m3", kind: "detail", title: "图.png", size: 190 << 20, binary: true, rev: 1}}
	bin := func(mb int) []byte { b := make([]byte, mb<<20); return b }
	text := func(n int) []byte { return []byte(strings.Repeat("字", n)) }
	cases := []struct {
		name string
		in   MaterialInput
		want []materialSlot
		code string
	}{
		{"新细节", MaterialInput{Files: []MaterialFile{{"b.md", text(100)}}}, []materialSlot{{kind: "detail", title: "b.md", units: 100, size: 300}}, ""},
		{"同名细节追加一版", MaterialInput{Files: []MaterialFile{{"a.md", text(48000)}}},
			[]materialSlot{{id: "m2", rev: 1, kind: "detail", title: "a.md", units: 48000, size: 144000}}, ""},
		{"总览换一份也是同一条的新版", MaterialInput{Overview: true, Files: []MaterialFile{{"新总览.md", text(3000)}}},
			[]materialSlot{{id: "m1", rev: 2, kind: "overview", title: "新总览.md", units: 3000, size: 9000}}, ""},
		{"二进制不占字数", MaterialInput{Files: []MaterialFile{{"b.png", bin(10)}}},
			[]materialSlot{{kind: "detail", title: "b.png", size: 10 << 20, binary: true}}, ""},
		{"单个文件超 20MB", MaterialInput{Files: []MaterialFile{{"c.png", bin(21)}}}, nil, "limit"},
		{"部门二进制合计超 200MB", MaterialInput{Files: []MaterialFile{{"c.png", bin(11)}}}, nil, "limit"},
		{"同名二进制换一版只算新的", MaterialInput{Files: []MaterialFile{{"图.png", bin(20)}}},
			[]materialSlot{{id: "m3", rev: 1, kind: "detail", title: "图.png", size: 20 << 20, binary: true}}, ""},
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
	big := func(mb float64) string { return string(make([]byte, int(mb*(1<<20)))) }
	cases := []struct {
		name  string
		files map[string]string
		code  string
		msg   string // 报错里要有的片段
	}{
		{"做法加附属文件", map[string]string{"SKILL.md": "x", "refs/a.md": "y"}, "", ""},
		{"缺 SKILL.md", map[string]string{"README.md": "x"}, "usage", ""},
		{"SKILL.md 超长", map[string]string{"SKILL.md": strings.Repeat("x", MaxSkillBody+1)}, "limit", ""},
		{"SKILL.md 不是文本", map[string]string{"SKILL.md": "\x00"}, "usage", ""},
		{"路径越界", map[string]string{"SKILL.md": "x", "../a": "y"}, "usage", ""},
		{"隐藏文件", map[string]string{"SKILL.md": "x", ".hidden": "y"}, "usage", ""},
		{"绝对路径", map[string]string{"SKILL.md": "x", "/abs": "y"}, "usage", ""},
		{"太深", map[string]string{"SKILL.md": "x", "a/b/c/d": "y"}, "usage", ""},
		{"截图等二进制收", map[string]string{"SKILL.md": "x", "shots/a.png": big(1.2)}, "", ""},
		{"单个文件超", map[string]string{"SKILL.md": "x", "a.png": big(MaxSkillFile + 0.5)}, "limit", "a.png 有 5.5 MB，超过上限 5 MB（多 0.5 MB）"},
		{"合计超", map[string]string{"SKILL.md": "x", "a.png": big(4), "b.png": big(4), "c.png": big(2.5)}, "limit", "web 有 10.5 MB，超过上限 10 MB（多 0.5 MB）"},
	}
	for _, c := range cases {
		files := map[string][]byte{}
		for p, v := range c.files {
			files[p] = []byte(v)
		}
		err := CheckSkillFiles("web", files)
		if got := code(err); got != c.code || (c.msg != "" && !strings.Contains(err.Error(), c.msg)) {
			t.Errorf("%s：%s %v，想要 %s %q", c.name, got, err, c.code, c.msg)
		}
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

// 报告连图片传目录：标题是相对目录的路径，隐藏项跳过（网页预览按这个路径找图）。
func TestReadLocalMaterialsDir(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{"report.md": "![](images/arch.png)", "images/arch.png": "PNG", ".git/HEAD": "x", "images/.tmp": "x"} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	files, err := readLocalMaterials(dir)
	var names []string
	for _, f := range files {
		names = append(names, f.Name)
	}
	if err != nil || !reflect.DeepEqual(names, []string{"images/arch.png", "report.md"}) {
		t.Fatalf("%v %v", names, err)
	}
}

func TestResourcesStore(t *testing.T) {
	db, data := openDB(t)
	ctx := context.Background()
	root, _ := Add(ctx, db, NewDept{Name: "公司"})
	sub, _ := Add(ctx, db, NewDept{Name: "运行时", Parent: root.ID})
	other, _ := Add(ctx, db, NewDept{Name: "别的"})

	// 技能：建、只改元数据沿用文件、超过保留版数时删最旧的。
	k, err := SaveSkill(ctx, db, data, SkillInput{Name: "fix-bug", Files: map[string][]byte{"SKILL.md": []byte("# 修 bug\n先复现"), "refs/x.md": []byte("附")}}, "u1")
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
		if _, err := SaveSkill(ctx, db, data, SkillInput{Name: "fix-bug", Files: map[string][]byte{"SKILL.md": []byte("v")}}, "u1"); err != nil {
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
	// 追加一版不给 --note 沿用上一版说明；新建不给要拒绝。读出来带部门名称。
	d3, err := AddMaterials(ctx, db, data, MaterialInput{Org: sub.ID, Files: []MaterialFile{{"a.md", []byte(strings.Repeat("字", 46000))}}}, "u1")
	if err != nil || d3[0].Rev != 3 || d3[0].Note != "改" || d3[0].OrgName != sub.Name {
		t.Fatalf("追加一版沿用说明：%+v %v", d3, err)
	}
	if _, err := AddMaterials(ctx, db, data, MaterialInput{Org: sub.ID, Files: []MaterialFile{{"c.md", []byte("1")}}}, "u1"); code(err) != "usage" {
		t.Fatalf("新建不给说明应拒绝：%v", err)
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
	if got["secrets"] != 1 || got["overview"] != 3 || got["materials"] != 3+4000 {
		t.Fatalf("计数 %v", got)
	}
	if g, _ := Counts(ctx, db, ""); g[1].Key != "skills" || g[1].Used != 1 {
		t.Fatalf("全局计数 %+v", g)
	}
}

// 用户全局原则：现读假主目录的 AGENTS.md，原文带标题；没有文件或只有空白都不出这一节。
func TestPrinciples(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if got, err := Principles(); err != nil || got != "" {
		t.Fatalf("没有文件应为空：%q %v", got, err)
	}
	os.WriteFile(filepath.Join(home, "AGENTS.md"), []byte(" \n"), 0o600)
	if got, err := Principles(); err != nil || got != "" {
		t.Fatalf("只有空白应为空：%q %v", got, err)
	}
	os.WriteFile(filepath.Join(home, "AGENTS.md"), []byte("## 表达\n\n- 先给结论\n"), 0o600)
	got, err := Principles()
	if err != nil || got != "## 用户的全局原则（~/AGENTS.md，优先于部门要点）\n\n## 表达\n\n- 先给结论\n" {
		t.Fatalf("原文应带标题放进来：%q %v", got, err)
	}
}
