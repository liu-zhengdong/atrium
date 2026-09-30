package org

import (
	"context"
	"errors"
	"fmt"
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
	if u, bin := Units("a.txt", []byte("你好ab")); u != 4 || bin {
		t.Fatalf("文本按字：%d %v", u, bin)
	}
	if u, bin := Units("a.bin", []byte{0, 1, 2, 3}); u != 0 || !bin {
		t.Fatalf("二进制不折算字数：%d %v", u, bin)
	}
	existing := []materialSlot{{id: "m1", kind: "overview", title: "总览.md", units: 1000, rev: 2},
		{id: "m2", kind: "detail", title: "a.md", units: 40000, rev: 1},
		{id: "m3", kind: "detail", title: "图.png", bin: 190 << 20, rev: 1}}
	bin := func(mb int) []byte { b := make([]byte, mb<<20); return b }
	text := func(n int) []byte { return []byte(strings.Repeat("字", n)) }
	one := func(name string, content []byte) []MaterialFile { return []MaterialFile{{name, content}} }
	info := func(p string, size, units int, binary bool) MaterialFileInfo {
		return MaterialFileInfo{Path: p, Size: size, Units: units, Binary: binary}
	}
	cases := []struct {
		name string
		in   MaterialInput
		want materialSlot
		code string
	}{
		{"新细节：标题取文件名", MaterialInput{Files: one("b.md", text(100))},
			materialSlot{kind: "detail", title: "b.md", entry: "b.md", files: []MaterialFileInfo{info("b.md", 300, 100, false)}, units: 100}, ""},
		{"同名也是新建一条，不碰已有的", MaterialInput{Files: one("a.md", text(100))},
			materialSlot{kind: "detail", title: "a.md", entry: "a.md", files: []MaterialFileInfo{info("a.md", 300, 100, false)}, units: 100}, ""},
		{"给 m2 加一版：标题沿用，总量只算新的", MaterialInput{ID: "m2", Title: "b.md", Files: one("b.md", text(48000))},
			materialSlot{id: "m2", rev: 1, kind: "detail", title: "a.md", entry: "b.md", files: []MaterialFileInfo{info("b.md", 144000, 48000, false)}, units: 48000}, ""},
		{"给总览加一版", MaterialInput{ID: "m1", Files: one("新总览.md", text(3000))},
			materialSlot{id: "m1", rev: 2, kind: "overview", title: "总览.md", entry: "新总览.md", files: []MaterialFileInfo{info("新总览.md", 9000, 3000, false)}, units: 3000}, ""},
		{"已有总览再新建一份", MaterialInput{Overview: true, Files: one("新总览.md", text(10))}, materialSlot{}, "conflict"},
		{"加一版不写 --overview", MaterialInput{ID: "m1", Overview: true, Files: one("o.md", text(10))}, materialSlot{}, "usage"},
		{"加一版的资料不在部门里", MaterialInput{ID: "m9", Files: one("o.md", text(10))}, materialSlot{}, "not_found"},
		{"目录是一条：报告和图片合计，附属文件计入大小", MaterialInput{Title: "t446-show", Files: []MaterialFile{
			{"report.md", text(10)}, {"images/a.png", bin(2)}, {"images/a.mmd", text(5)}}},
			materialSlot{kind: "detail", title: "t446-show", entry: "report.md", units: 15, bin: 2 << 20, files: []MaterialFileInfo{
				info("images/a.mmd", 15, 5, false), info("images/a.png", 2<<20, 0, true), info("report.md", 30, 10, false)}}, ""},
		{"目录的附属文件超部门二进制合计", MaterialInput{Title: "d", Files: []MaterialFile{{"report.md", text(1)}, {"a.png", bin(11)}}}, materialSlot{}, "limit"},
		{"目录要有标题", MaterialInput{Files: []MaterialFile{{"report.md", text(1)}, {"a.png", bin(1)}}}, materialSlot{}, "usage"},
		{"目录总览不行", MaterialInput{ID: "m1", Files: []MaterialFile{{"report.md", text(1)}, {"b.md", text(1)}}}, materialSlot{}, "usage"},
		{"二进制不占字数", MaterialInput{Files: one("b.png", bin(10))},
			materialSlot{kind: "detail", title: "b.png", entry: "b.png", files: []MaterialFileInfo{info("b.png", 10<<20, 0, true)}, bin: 10 << 20}, ""},
		{"单个文件超 20MB", MaterialInput{Files: one("c.png", bin(21))}, materialSlot{}, "limit"},
		{"部门二进制合计超 200MB", MaterialInput{Files: one("c.png", bin(11))}, materialSlot{}, "limit"},
		{"二进制换一版只算新的", MaterialInput{ID: "m3", Files: one("图.png", bin(20))},
			materialSlot{id: "m3", rev: 1, kind: "detail", title: "图.png", entry: "图.png", files: []MaterialFileInfo{info("图.png", 20<<20, 0, true)}, bin: 20 << 20}, ""},
		{"总览超 3000 字", MaterialInput{ID: "m1", Files: one("o.md", text(3001))}, materialSlot{}, "limit"},
		{"总览不能是二进制", MaterialInput{ID: "m1", Files: one("o.png", []byte{0, 0})}, materialSlot{}, "usage"},
		{"部门合计超 5 万字", MaterialInput{Files: one("c.md", text(9001))}, materialSlot{}, "limit"},
		{"重复文件", MaterialInput{Title: "d", Files: []MaterialFile{{"c.md", text(1)}, {"c.md", text(1)}}}, materialSlot{}, "usage"},
		{"越出目录的路径", MaterialInput{Title: "d", Files: []MaterialFile{{"../c.md", text(1)}, {"b.md", text(1)}}}, materialSlot{}, "usage"},
		{"没有文件", MaterialInput{Title: "d"}, materialSlot{}, "usage"},
	}
	for _, c := range cases {
		got, err := PlanMaterial("o1", existing, c.in)
		if c.code == "" {
			c.want.bin = 0
			for _, f := range c.want.files {
				c.want.bin += f.Size
			}
		}
		if code(err) != c.code || (c.code == "" && !reflect.DeepEqual(got, c.want)) {
			t.Errorf("%s：%+v %v", c.name, got, err)
		}
	}
}

// 正文：指定的、唯一的文件、约定的名字、唯一的文档；全是图片是图片集；认不出报错。
func TestPickEntry(t *testing.T) {
	files := func(names ...string) []MaterialFileInfo {
		var out []MaterialFileInfo
		for _, n := range names {
			out = append(out, MaterialFileInfo{Path: n})
		}
		return out
	}
	for _, c := range []struct {
		files []MaterialFileInfo
		want  string
		entry string
		code  string
	}{
		{files("notes.txt"), "", "notes.txt", ""},
		{files("images/a.png", "report.md", "README.md"), "", "report.md", ""},
		{files("README.md", "index.html", "proto.js"), "", "README.md", ""},
		{files("Readme.md", "a.png"), "", "Readme.md", ""},
		{files("index.html", "style.css"), "", "index.html", ""},
		{files("design.md", "a.png", "today.patch"), "", "design.md", ""},
		{files("sub/page.html", "sub/a.png"), "", "sub/page.html", ""},
		{files("shots/a.png", "shots/b.jpg"), "", "", ""},
		{files("a.md", "b.md"), "", "", "usage"},
		{files("a.md", "b.md"), "b.md", "b.md", ""},
		{files("a.md", "b.md"), "c.md", "", "usage"},
		{files("data.csv", "a.png"), "", "", "usage"},
	} {
		got, err := PickEntry(c.files, c.want)
		if got != c.entry || code(err) != c.code {
			t.Errorf("%v %q：%q %v", c.files, c.want, got, err)
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
	ks := []Skill{{Name: "fix", Summary: "修 bug"}, {Name: "web"}}
	for _, c := range []struct{ except, want string }{
		{"", "## 技能索引（Atrium 全部技能）\n\n跟这件活相关的先读再动手，atrium skill ls <名字> 取做法与附属文件：\n\n- fix：修 bug\n- web：（没有说明）\n"},
		{"fix", "## 技能索引（Atrium 全部技能）\n\n跟这件活相关的先读再动手，atrium skill ls <名字> 取做法与附属文件：\n\n- web：（没有说明）\n"},
	} {
		if got := SkillIndex(ks, c.except); got != c.want {
			t.Errorf("除去 %q：\n%s\n想要：\n%s", c.except, got, c.want)
		}
	}
	if SkillIndex(nil, "") != "" || SkillIndex(ks[:1], "fix") != "" {
		t.Error("没有技能（或只有挂上的那个）不出索引")
	}
	for name, ok := range map[string]bool{"web-design": true, "a1": true, "Web": false, "a--b": false, "-a": false, "a/b": false} {
		if (CheckSkillName(name) == nil) != ok {
			t.Errorf("技能名 %q", name)
		}
	}
	big := func(mb float64) string { return string(make([]byte, int(mb*(1<<20)))) }
	// layer 往 files 里加 n 个文件，都在目录 dir 下（dir 为空是根目录）。
	layer := func(files map[string]string, dir string, n int) map[string]string {
		for i := range n {
			files[fmt.Sprintf("%sf%02d.png", dir, i)] = "y"
		}
		return files
	}
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
		{"总数过 16、每层不过 12", layer(layer(layer(map[string]string{"SKILL.md": "x"}, "", 9), "taste/good/", 12), "taste/bad/", 12), "", ""},
		{"某层 13 项", layer(map[string]string{"SKILL.md": "x"}, "taste/", 13), "limit", "技能 web 的 taste/ 有 13 项（直接的文件与子文件夹），每层上限 12 项：按用途收进子文件夹"},
		{"深层 13 项", layer(map[string]string{"SKILL.md": "x"}, "taste/bad/", 13), "limit", "taste/bad/ 有 13 项"},
		{"子文件夹也算一项", layer(map[string]string{"SKILL.md": "x", "refs/a.md": "y"}, "", 11), "limit", "技能 web 的根目录有 13 项"},
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

// 技能文件按名字和相对路径取（skill ls <名字>/<相对路径>），在哪台机器上都一样：
// 做法里的 ../<另一技能>/<路径> 就是 <另一技能>/<路径>，取到对方的最新版；路径出不了技能目录。
func TestSkillFile(t *testing.T) {
	db, data := openDB(t)
	ctx := context.Background()
	save := func(name string, files map[string]string) {
		t.Helper()
		in := SkillInput{Name: name, Files: map[string][]byte{}}
		for p, c := range files {
			in.Files[p] = []byte(c)
		}
		if _, err := SaveSkill(ctx, db, data, in, "u1"); err != nil {
			t.Fatal(err)
		}
	}
	save("a", map[string]string{"SKILL.md": "写作本身按 [b](../b/SKILL.md)，口味见 [x](../b/refs/x.md)"})
	save("b", map[string]string{"SKILL.md": "b 第一版", "refs/x.md": "口味一", "shot.png": "\x89PNG\x00"})
	get := func(name, rel string) (SkillFile, string) {
		t.Helper()
		f, err := GetSkillFile(ctx, db, data, name, rel)
		return f, code(err)
	}
	if f, c := get("b", "refs/x.md"); c != "" || string(f.Content) != "口味一" || f.Binary || f.Rev != 1 {
		t.Fatalf("附属文件：%+v %s", f, c)
	}
	if f, _ := get("b", "shot.png"); !f.Binary {
		t.Fatal("图片应标成二进制")
	}
	if k, err := ShowSkill(ctx, db, data, "b"); err != nil || k.Body != "b 第一版" || !reflect.DeepEqual(k.Others, []string{"refs/x.md", "shot.png"}) {
		t.Fatalf("做法与附属文件清单：%+v %v", k, err)
	}
	save("b", map[string]string{"SKILL.md": "b 第二版"})
	if f, _ := get("b", "SKILL.md"); string(f.Content) != "b 第二版" || f.Rev != 2 {
		t.Fatalf("改版后取到最新版：%+v", f)
	}
	if _, c := get("b", "refs/x.md"); c != "not_found" {
		t.Fatal("新版没有的附属文件应取不到")
	}
	for _, rel := range []string{"../a/SKILL.md", "/etc/passwd", ".hidden", "refs/../../a/SKILL.md", `refs\x.md`} {
		if _, c := get("b", rel); c != "usage" {
			t.Errorf("%q 应拒绝，得到 %q", rel, c)
		}
	}
	if _, c := get("nope", "SKILL.md"); c != "not_found" {
		t.Fatal("没有的技能")
	}
}

// 命令行读技能目录：跳过隐藏项，文件总数不限，某层超了按同一判定报出是哪一层。
func TestReadLocalSkill(t *testing.T) {
	write := func(dir string, names ...string) {
		for _, name := range names {
			p := filepath.Join(dir, filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	ok := t.TempDir()
	write(ok, "SKILL.md", ".git/HEAD", "taste/.DS_Store")
	for i := range 10 {
		write(ok, fmt.Sprintf("taste/good/%d.png", i), fmt.Sprintf("taste/bad/%d.png", i))
	}
	files, err := readLocalSkill("web", ok)
	if err != nil || len(files) != 21 || files["taste/bad/9.png"] == nil || files[".git/HEAD"] != nil {
		t.Fatalf("21 个文件、每层不过 12 应能读，隐藏项跳过：%d %v", len(files), err)
	}
	full := t.TempDir()
	write(full, "SKILL.md")
	for i := range 13 {
		write(full, fmt.Sprintf("taste/%d.png", i))
	}
	if _, err := readLocalSkill("web", full); code(err) != "limit" || !strings.Contains(err.Error(), "taste/ 有 13 项") {
		t.Fatalf("某层 13 项应报出是哪一层：%v", err)
	}
}

// 报告连图片传目录：标题是相对目录的路径，隐藏项跳过（网页预览按这个路径找图）。
func TestReadLocalMaterialDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "t446-show")
	for name, body := range map[string]string{"report.md": "![](images/arch.png)", "images/arch.png": "PNG", ".git/HEAD": "x", "images/.tmp": "x"} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	title, files, err := readLocalMaterial(dir)
	var names []string
	for _, f := range files {
		names = append(names, f.Name)
	}
	if err != nil || title != "t446-show" || !reflect.DeepEqual(names, []string{"images/arch.png", "report.md"}) {
		t.Fatalf("%q %v %v", title, names, err)
	}
	if title, files, err := readLocalMaterial(filepath.Join(dir, "report.md")); err != nil || title != "report.md" || len(files) != 1 || files[0].Name != "report.md" {
		t.Fatalf("单个文件：%q %+v %v", title, files, err)
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
	if f, err := GetSkillFile(ctx, db, data, "fix-bug", "refs/x.md"); err != nil || string(f.Content) != "附" || f.Rev != 2 {
		t.Fatalf("附属文件沿用：%+v %v", f, err)
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
	if _, err := GetSkill(ctx, db, "nope"); code(err) != "not_found" {
		t.Fatal("没有的技能分派任务应报错")
	}

	// 资料：总览、细节、同名新建、给 mN 加一版、归档不算用量、撤销归档查上限。
	ms, err := AddMaterial(ctx, db, data, MaterialInput{Org: sub.ID, Overview: true, Note: "总览", Files: []MaterialFile{{"总览.md", []byte("是什么")}}}, "u1")
	if err != nil || ms.Kind != "overview" || ms.Units != 3 {
		t.Fatalf("%+v %v", ms, err)
	}
	if ov, err := Overview(ctx, db, data, sub.ID); err != nil || ov != "是什么" {
		t.Fatalf("总览：%q %v", ov, err)
	}
	d1, _ := AddMaterial(ctx, db, data, MaterialInput{Org: sub.ID, Note: "细节", Files: []MaterialFile{{"a.md", []byte("1")}}}, "u1")
	same, err := AddMaterial(ctx, db, data, MaterialInput{Org: sub.ID, Note: "另一份", Files: []MaterialFile{{"a.md", []byte("2")}}}, "u1")
	if err != nil || same.ID == d1.ID || same.Rev != 1 {
		t.Fatalf("同名新建一条：%+v %v", same, err)
	}
	if old, err := GetMaterial(ctx, db, data, d1.ID, 0); err != nil || old.Rev != 1 || old.Note != "细节" {
		t.Fatalf("同名新建不动已有的：%+v %v", old, err)
	}
	if _, err := ArchiveMaterial(ctx, db, data, same.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := AddMaterial(ctx, db, data, MaterialInput{ID: same.ID, Files: []MaterialFile{{"a.md", []byte("3")}}}, "u1"); code(err) != "conflict" {
		t.Fatalf("给已归档的加一版应拒绝：%v", err)
	}
	d2, err := AddMaterial(ctx, db, data, MaterialInput{ID: d1.ID, Note: "改", Files: []MaterialFile{{"a.md", []byte(strings.Repeat("字", 46000))}}}, "u1")
	if err != nil || d2.ID != d1.ID || d2.Rev != 2 {
		t.Fatalf("给 mN 加一版：%+v %v", d2, err)
	}
	// 加一版不给 --note 沿用上一版说明；新建不给要拒绝。读出来带部门名称。
	d3, err := AddMaterial(ctx, db, data, MaterialInput{ID: d1.ID, Files: []MaterialFile{{"a.md", []byte(strings.Repeat("字", 46000))}}}, "u1")
	if err != nil || d3.Rev != 3 || d3.Note != "改" || d3.OrgName != sub.Name {
		t.Fatalf("加一版沿用说明：%+v %v", d3, err)
	}
	if _, err := AddMaterial(ctx, db, data, MaterialInput{Org: sub.ID, Files: []MaterialFile{{"c.md", []byte("1")}}}, "u1"); code(err) != "usage" {
		t.Fatalf("新建不给说明应拒绝：%v", err)
	}
	if old, err := GetMaterial(ctx, db, data, d1.ID, 1); err != nil || old.Units != 1 {
		t.Fatalf("旧版还在：%+v %v", old, err)
	}
	if _, err := AddMaterial(ctx, db, data, MaterialInput{Org: sub.ID, Note: "x", Files: []MaterialFile{{"b.md", []byte(strings.Repeat("字", 4000))}}}, "u1"); code(err) != "limit" {
		t.Fatalf("超总量应拒绝：%v", err)
	}
	if _, err := ArchiveMaterial(ctx, db, data, d1.ID, false); err != nil {
		t.Fatal(err)
	}
	b, err := AddMaterial(ctx, db, data, MaterialInput{Org: sub.ID, Note: "x", Files: []MaterialFile{{"b.md", []byte(strings.Repeat("字", 4000))}}}, "u1")
	if err != nil {
		t.Fatalf("归档后腾出地方：%v", err)
	}
	_ = b
	if _, err := ArchiveMaterial(ctx, db, data, d1.ID, true); code(err) != "limit" {
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

// 目录资料：一条、正文与附属文件按相对路径取，全部文件计入部门原始字节总量。
func TestMaterialDir(t *testing.T) {
	db, data := openDB(t)
	ctx := context.Background()
	dept, _ := Add(ctx, db, NewDept{Name: "调研"})
	png := append([]byte{0x89, 0}, make([]byte, 3<<20)...)
	m, err := AddMaterial(ctx, db, data, MaterialInput{Org: dept.ID, Title: "t446-show", Note: "报告", Files: []MaterialFile{
		{"report.md", []byte("![](images/a.png)")}, {"images/a.png", png}, {"images/a.mmd", []byte("graph")}}}, "u1")
	if err != nil || m.Entry != "report.md" || len(m.Files) != 3 || m.Size != 17+len(png)+5 || m.Units != 22 {
		t.Fatalf("%+v %v", m, err)
	}
	if got := materialAmount(m); got != "3 个文件 · 22 字 · 3.0 MB" {
		t.Fatalf("量：%q", got)
	}
	if f, p, err := m.File("images/a.png"); err != nil || !f.Binary {
		t.Fatalf("附属文件：%+v %v", f, err)
	} else if raw, _ := os.ReadFile(p); len(raw) != len(png) {
		t.Fatal("附属文件按相对路径存")
	}
	if _, _, err := m.File("../x"); code(err) != "not_found" {
		t.Fatal("不在资料里的路径应找不到")
	}
	if list, err := Materials(ctx, db, data, MaterialFilter{Org: dept.ID}); err != nil || len(list) != 1 || len(list[0].Files) != 3 {
		t.Fatalf("列表里只占一行、带文件清单：%+v %v", list, err)
	}
	counts, _ := Counts(ctx, db, dept.ID)
	for _, c := range counts {
		if (c.Key == "material_bin" && c.Used != MB(m.Size)) || (c.Key == "materials" && c.Used != 22) {
			t.Fatalf("用量：%+v", c)
		}
	}
	// 给 mN 加一版换掉全部文件；图片集没有正文。
	m2, err := AddMaterial(ctx, db, data, MaterialInput{ID: m.ID, Files: []MaterialFile{{"report.md", []byte("新")}}}, "u1")
	if err != nil || m2.ID != m.ID || m2.Rev != 2 || len(m2.Files) != 1 {
		t.Fatalf("追加一版：%+v %v", m2, err)
	}
	set, err := AddMaterial(ctx, db, data, MaterialInput{Org: dept.ID, Title: "shots", Note: "截图", Files: []MaterialFile{{"a.png", png}, {"b.png", png}}}, "u1")
	if err != nil || set.Entry != "" {
		t.Fatalf("图片集：%+v %v", set, err)
	}
	if _, _, err := set.File(""); code(err) != "not_found" {
		t.Fatal("图片集没有正文")
	}
	if _, err := AddMaterial(ctx, db, data, MaterialInput{Org: dept.ID, Title: "x", Note: "x", Files: []MaterialFile{{"a.md", nil}, {"b.md", nil}}}, "u1"); code(err) != "usage" {
		t.Fatalf("认不出正文应报错：%v", err)
	}
}

// 旧资料（没有 material_files）：一个目录拆出来的几条合并成一条，保留正文那条的短号；单个的只补文件清单。
func TestMergeFlatMaterials(t *testing.T) {
	db, data := openDB(t)
	ctx := context.Background()
	dept, _ := Add(ctx, db, NewDept{Name: "调研"})
	old := func(id string, rev int, title, note, by string, at int64, body string, archived bool) {
		t.Helper()
		units, binary := Units(title, []byte(body))
		base := filepath.Base(title)
		var arch any
		if archived {
			arch = at
		}
		if _, err := db.Exec(`INSERT INTO materials (`+materialCols+`) VALUES (?, ?, ?, 'detail', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, rev, dept.ID, title, note, base, len(body), units, binary, arch, by, at); err != nil {
			t.Fatal(err)
		}
		if err := writeFile(materialFile(data, id, rev, base), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	const note = "t446 研究报告（正文与图）；要了解时看"
	old("m1", 1, "report.md", note, "a1", 100, "旧正文", false)
	old("m1", 2, "report.md", note, "a1", 5000, "![](images/a.png)", false)
	old("m2", 1, "images/a.png", note, "a1", 4999, "\x89PNG\x00", false)
	old("m3", 1, "images/a.mmd", note, "a1", 5001, "graph", false)
	old("m4", 1, "other.md", "别的", "a1", 5000, "别的", false)              // 说明不同
	old("m5", 1, "late.md", note, "a1", 9000, "晚", false)                // 隔得久
	old("m6", 1, "gone.md", note, "a1", 5000, "归档", true)                // 归档的不动
	old("m7", 1, "shots/a.png", "截图", "a1", 7000, "\x89PNG\x00a", false) // 没有正文：图片集，标题取共同目录
	old("m8", 1, "shots/b.png", "截图", "a1", 7000, "\x89PNG\x00b", false)

	n, err := mergeFlatMaterials(ctx, db, data)
	if err != nil || n != 2 {
		t.Fatalf("合并组数：%d %v", n, err)
	}
	list, err := Materials(ctx, db, data, MaterialFilter{Org: dept.ID})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, m := range list {
		got = append(got, fmt.Sprintf("%s r%d %s %s %d", m.ID, m.Rev, m.Title, m.Entry, len(m.Files)))
	}
	want := []string{"m5 r1 late.md late.md 1", "m4 r1 other.md other.md 1", "m7 r2 shots  2", "m1 r3 t446 研究报告 report.md 3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("合并后：%q", got)
	}
	m1 := list[3]
	if f, p, err := m1.File("images/a.png"); err != nil || !f.Binary || m1.Units != len([]rune("![](images/a.png)"))+5 {
		t.Fatalf("%+v %v", m1, err)
	} else if raw, _ := os.ReadFile(p); string(raw) != "\x89PNG\x00" {
		t.Fatalf("附属文件搬到新版：%q", raw)
	}
	if old, err := GetMaterial(ctx, db, data, "m1", 1); err != nil || len(old.Files) != 1 || old.Entry != "report.md" {
		t.Fatalf("旧版补了文件清单：%+v %v", old, err)
	}
	for _, id := range []string{"m2", "m3", "m8"} {
		if _, err := GetMaterial(ctx, db, data, id, 0); code(err) != "not_found" {
			t.Fatalf("%s 应并掉", id)
		}
		if _, err := os.Stat(filepath.Join(data, "materials", id)); !os.IsNotExist(err) {
			t.Fatalf("%s 的文件应删掉", id)
		}
	}
	if m6, err := GetMaterial(ctx, db, data, "m6", 0); err != nil || len(m6.Files) != 1 {
		t.Fatalf("归档的只补清单：%+v %v", m6, err)
	}
	if n, err := mergeFlatMaterials(ctx, db, data); err != nil || n != 0 {
		t.Fatalf("再跑什么都不做：%d %v", n, err)
	}
}

func TestMaterialSVGUnits(t *testing.T) {
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><text>矢量图</text></svg>`)
	for _, name := range []string{"images/a.svg", "images/a.SVG", "images/a.txt"} {
		t.Run(name, func(t *testing.T) {
			db, data := openDB(t)
			ctx := context.Background()
			dept, err := Add(ctx, db, NewDept{Name: "调研"})
			if err != nil {
				t.Fatal(err)
			}
			m, err := AddMaterial(ctx, db, data, MaterialInput{Org: dept.ID, Title: "报告", Note: "SVG 计量样本", Files: []MaterialFile{
				{Name: "report.md", Content: []byte("正文")}, {Name: name, Content: svg},
			}}, "u1")
			if err != nil {
				t.Fatal(err)
			}
			wantUnits, wantBin := 2, len(svg)+len([]byte("正文"))
			binary := !strings.HasSuffix(name, ".txt")
			if !binary {
				wantUnits += len([]rune(string(svg)))
				wantBin = len(svg) + len([]byte("正文"))
			}
			if m.Units != wantUnits || m.rawBytes() != wantBin {
				t.Fatalf("计量：%+v，原始字节 %d", m, m.rawBytes())
			}
			f, p, err := m.File(name)
			if err != nil {
				t.Fatal(err)
			}
			if f.Binary != binary || f.Units != wantUnits-2 {
				t.Fatalf("文件计量：%+v", f)
			}
			raw, err := os.ReadFile(p)
			if err != nil || string(raw) != string(svg) {
				t.Fatalf("原文件：%q %v", raw, err)
			}
		})
	}
}
