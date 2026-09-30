package org

import (
	"context"
	"database/sql"
	"os"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestRecountMaterials(t *testing.T) {
	db, data := openDB(t)
	ctx := context.Background()
	dept, err := Add(ctx, db, NewDept{Name: "资料计量"})
	if err != nil {
		t.Fatal(err)
	}
	files := []MaterialFile{
		{Name: "report.html", Content: []byte("<style>样式</style><p>正文</p>")},
		{Name: "image.md", Content: []byte("![](data:image/png;base64,AAAA)")},
		{Name: "a.svg", Content: []byte("<svg>图</svg>")},
		{Name: "notes.txt", Content: []byte("你好ab")},
	}
	size := 0
	for _, f := range files {
		size += len(f.Content)
	}
	// 旧口径且 SVG 也被误计为文本；超过一页，覆盖历史与已归档版本。
	for rev := 1; rev <= 26; rev++ {
		s := materialSlot{id: "m1", rev: rev, kind: "detail", title: "旧资料", entry: "report.html", units: 400}
		for _, f := range files {
			s.files = append(s.files, MaterialFileInfo{Path: f.Name, Size: len(f.Content), Units: 100})
			if err := writeFile(materialFile(data, "m1", rev, f.Name), f.Content, 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if err := db.Tx(ctx, func(tx *sql.Tx) error { return insertMaterialRev(ctx, tx, s, dept.ID, "u1", store.Now()) }); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `UPDATE materials SET archived_at = 1 WHERE rev < 26`); err != nil {
		t.Fatal(err)
	}
	missing := materialFile(data, "m1", 26, "notes.txt")
	if err := os.Remove(missing); err != nil {
		t.Fatal(err)
	}
	if err := recountMaterials(ctx, db, data); err == nil {
		t.Fatal("缺文件应报错")
	}
	old, err := GetMaterial(ctx, db, data, "m1", 1)
	if err != nil || old.Units != 400 || old.Files[0].Binary {
		t.Fatalf("失败应回滚：%+v %v", old, err)
	}
	if err := writeFile(missing, files[3].Content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := recountMaterials(ctx, db, data); err != nil {
		t.Fatal(err)
	}
	for rev := 1; rev <= 26; rev++ {
		m, err := GetMaterial(ctx, db, data, "m1", rev)
		if err != nil || m.Units != 11 || m.rawBytes() != size {
			t.Fatalf("r%d 重算：%+v %v", rev, m, err)
		}
		f, _, err := m.File("a.svg")
		if err != nil || !f.Binary || f.Units != 0 {
			t.Fatalf("SVG 重算：%+v %v", f, err)
		}
	}
	counts, err := Counts(ctx, db, dept.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range counts {
		if c.Key == "materials" && c.Used != 11 {
			t.Fatalf("部门字数：%+v", c)
		}
	}
	// 成功后的启动不再读取文件。
	if err := os.Remove(missing); err != nil {
		t.Fatal(err)
	}
	if err := recountMaterials(ctx, db, data); err != nil {
		t.Fatalf("重复启动：%v", err)
	}
}

func TestMaterialRawByteLimit(t *testing.T) {
	raw := []byte("<style>" + string(make([]byte, 100)) + "</style><p>正文</p>")
	// 使用合法文本，确保上限拦的是剥掉的字节。
	for i := range raw {
		if raw[i] == 0 {
			raw[i] = 'x'
		}
	}
	_, err := PlanMaterial("o1", []materialSlot{{id: "m1", bin: (MaxMaterialBin << 20) - len(raw) + 1}}, MaterialInput{Files: []MaterialFile{{Name: "report.html", Content: raw}}})
	if code(err) != "limit" {
		t.Fatalf("原始字节超限：%v", err)
	}
}
