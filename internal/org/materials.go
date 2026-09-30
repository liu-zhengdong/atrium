package org

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 资料：部门的知识分两层——一份「总览」（每次附给负责人，≤MaxOverview 字）与按需取的细节。
// 一个文件或一个目录是一条资料：目录里的入口文件（报告、README……）是正文，其余是附属文件，按相对路径存，正文里的相对引用在这条资料内部解析。
// Units：图片（含 SVG）与非文本不计字；其余合法 UTF-8、无 NUL 的内容按 rune 计字。
// HTML/HTM 只计去掉 style、script、注释、标签后的正文（解码实体、忽略文本段首尾空白）；HTML 与 Markdown 的 data URI 不计字。
// 整个部门没归档的资料：正文合计 ≤MaxMaterial 字，所有原始文件合计 ≤MaxMaterialBin MB（含剥掉的部分），单个文件 ≤MaxMaterialFile MB。
// 内容在 materials/<mN>/r<rev>/<相对路径>。加资料永远新建一条；给已有资料加一版要显式指明 mN，不按名字猜。
const (
	maxMaterialNote  = 200
	maxMaterialFiles = 50
	maxMaterialDepth = 4
	// 一次上传的原始字节上限（JSON 里 base64 再涨 1/3，请求体上限按它放宽）。
	maxMaterialRequest = 2 * MaxMaterialFile << 20
	// MaxMaterialBody 是资料上传接口的请求体上限，也是所有接口里最大的（负责人权限判定先读全请求体，按它读）。
	MaxMaterialBody = maxMaterialRequest/3*4 + 1<<20
)

type Material struct {
	ID         string             `json:"id"`
	Rev        int                `json:"rev"`
	Org        string             `json:"org"`
	OrgName    string             `json:"org_name"`
	Kind       string             `json:"kind"` // overview 或 detail
	Title      string             `json:"title"`
	Note       string             `json:"note"`
	Entry      string             `json:"entry"` // 正文文件（资料内的相对路径）；空表示没有正文（图片集），打开时列出全部文件
	Files      []MaterialFileInfo `json:"files"` // 这一版的全部文件（含正文），按路径排
	Size       int                `json:"size"`  // 全部文件合计字节
	Units      int                `json:"units"` // 其中文本文件合计字数
	ArchivedAt *int64             `json:"archived_at,omitempty"`
	CreatedBy  string             `json:"created_by"`
	CreatedAt  int64              `json:"created_at"`
	Dir        string             `json:"dir"` // 这一版文件所在目录的绝对路径（本机）
}

// MaterialFileInfo 是资料里的一个文件（库里的元数据）。
type MaterialFileInfo struct {
	Path   string `json:"path"` // 资料内的相对路径
	Size   int    `json:"size"`
	Units  int    `json:"units"`
	Binary bool   `json:"binary"`
}

// File 取资料里的一个文件：rel 空取正文。返回元数据与本机绝对路径。
func (m Material) File(rel string) (MaterialFileInfo, string, error) {
	if rel == "" {
		if m.Entry == "" {
			return MaterialFileInfo{}, "", api.NotFound("%s 没有正文（是 %d 个文件的图片集）：给出相对路径取其中一个", m.ID, len(m.Files)).
				WithNext("atrium material ls " + m.ID + "/" + firstPath(m.Files))
		}
		rel = m.Entry
	}
	for _, f := range m.Files {
		if f.Path == rel {
			return f, filepath.Join(m.Dir, filepath.FromSlash(rel)), nil
		}
	}
	return MaterialFileInfo{}, "", api.NotFound("资料 %s 第 %d 版里没有 %s", m.ID, m.Rev, rel)
}

func firstPath(fs []MaterialFileInfo) string {
	if len(fs) == 0 {
		return ""
	}
	return fs[0].Path
}

// rawBytes 汇总资料原始字节。
func (m Material) rawBytes() int {
	n := 0
	for _, f := range m.Files {
		n += f.Size
	}
	return n
}

type MaterialFile struct {
	Name    string `json:"name"`    // 资料内的相对路径
	Content []byte `json:"content"` // JSON 里是 base64
}

// MaterialInput 是 material add 的输入：一条资料的全部文件。Overview 时只能一个文本文件。
type MaterialInput struct {
	Org      string         `json:"org"`   // 新建在哪个部门
	ID       string         `json:"-"`     // 给哪条资料加一版（接口路径里的 mN）；空是在 Org 新建一条
	Title    string         `json:"title"` // 新建时的标题：目录名或文件名，只有一个文件时可省，取文件名；加一版时沿用原标题
	Entry    string         `json:"entry"` // 正文文件的相对路径；省了按 PickEntry 判
	Files    []MaterialFile `json:"files"`
	Overview bool           `json:"overview"`
	Note     string         `json:"note"`
}

// materialSlot 纯判定用：一条资料（部门现有的最新版，或这次要加的）。
type materialSlot struct {
	id, kind, title, note string
	entry                 string
	files                 []MaterialFileInfo
	units, bin, rev       int // bin：原始文件合计字节
}

func slotOf(m Material) materialSlot {
	return materialSlot{id: m.ID, kind: m.Kind, title: m.Title, note: m.Note, units: m.Units, bin: m.rawBytes(), rev: m.Rev}
}

var imageExts = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".avif": true, ".bmp": true, ".svg": true}

// PickEntry 纯判定：资料的正文文件。给了 want 就用它（要在文件里）；只有一个文件就是它；
// 否则依次找 report.md、README.md、index.html，再找唯一的 md 或 html；全是图片返回空（图片集）；都不是就报错，让加的人用 --entry 指定。
func PickEntry(files []MaterialFileInfo, want string) (string, error) {
	if want != "" {
		for _, f := range files {
			if f.Path == want {
				return want, nil
			}
		}
		return "", api.Usage("--entry: 资料里没有 %s", want)
	}
	if len(files) == 1 {
		return files[0].Path, nil
	}
	for _, name := range []string{"report.md", "readme.md", "index.html"} {
		for _, f := range files {
			if strings.EqualFold(f.Path, name) {
				return f.Path, nil
			}
		}
	}
	var docs []string
	images := 0
	for _, f := range files {
		switch ext := strings.ToLower(path.Ext(f.Path)); {
		case ext == ".md" || ext == ".markdown" || ext == ".html" || ext == ".htm":
			docs = append(docs, f.Path)
		case imageExts[ext]:
			images++
		}
	}
	switch {
	case len(docs) == 1:
		return docs[0], nil
	case len(docs) == 0 && images == len(files):
		return "", nil
	case len(docs) == 0:
		return "", api.Usage("--entry: 判不出正文：目录里没有 md 或 html，也不全是图片；用 --entry <相对路径> 指定正文")
	}
	if len(docs) > 4 {
		docs = append(docs[:4], "…")
	}
	return "", api.Usage("--entry: 判不出正文：%s 都可能是；用 --entry <相对路径> 指定，或把正文命名为 report.md", strings.Join(docs, "、"))
}

// PlanMaterial 纯判定：这次加的一条资料——in.ID 空是新建，否则给 existing 里的 in.ID 加一版（类别、标题、说明沿用）——
// 以及加完后部门总量是否超限。总览一个部门只有一份：已有时再新建要拒，给它加一版写它的 mN。
func PlanMaterial(dept string, existing []materialSlot, in MaterialInput) (materialSlot, error) {
	s := materialSlot{kind: "detail", title: in.Title}
	if in.Overview {
		s.kind = "overview"
	}
	if in.ID != "" {
		i := slices.IndexFunc(existing, func(e materialSlot) bool { return e.id == in.ID })
		switch {
		case in.Overview:
			return s, api.Usage("--overview: 给 %s 加一版时类别跟着原资料，不用写", in.ID)
		case i < 0:
			return s, api.NotFound("部门 %s 里没有资料 %s", dept, in.ID)
		}
		b := existing[i]
		s = materialSlot{id: b.id, rev: b.rev, kind: b.kind, title: b.title, note: b.note}
	} else if in.Overview {
		for _, e := range existing {
			if e.kind == "overview" {
				return s, api.Conflict("部门 %s 已有总览 %s：给它加一版写 %s", dept, e.id, e.id).
					WithNext("atrium material add " + e.id + " <文件>")
			}
		}
	}
	switch {
	case len(in.Files) == 0:
		return s, api.Usage("没有文件")
	case len(in.Files) > maxMaterialFiles:
		return s, api.Usage("一条资料最多 %d 个文件", maxMaterialFiles)
	case s.kind == "overview" && len(in.Files) != 1:
		return s, api.Usage("--overview: 总览只能是一个文件")
	case s.title == "" && len(in.Files) == 1:
		s.title = in.Files[0].Name
	}
	if err := checkText("title", s.title, 100, true); err != nil {
		return s, err
	}
	seen := map[string]bool{}
	for _, f := range in.Files {
		if err := CheckRelPath("files", f.Name, maxMaterialDepth); err != nil {
			return s, err
		}
		if seen[f.Name] {
			return s, api.Usage("文件 %s 重复", f.Name)
		}
		seen[f.Name] = true
		if len(f.Content) > MaxMaterialFile<<20 {
			return s, TooBig("material_file", f.Name, len(f.Content))
		}
		units, binary := Units(f.Name, f.Content)
		s.files = append(s.files, MaterialFileInfo{Path: f.Name, Size: len(f.Content), Units: units, Binary: binary})
		s.bin += len(f.Content)
		s.units += units
	}
	slices.SortFunc(s.files, func(a, b MaterialFileInfo) int { return strings.Compare(a.Path, b.Path) })
	var err error
	if s.entry, err = PickEntry(s.files, in.Entry); err != nil {
		return s, err
	}
	if s.kind == "overview" {
		if s.files[0].Binary {
			return s, api.Usage("总览要是文本文件：%s 不是", s.entry)
		}
		if s.units > MaxOverview {
			return s, Full("overview", dept, s.units)
		}
	}
	return s, checkTotals(dept, existing, s)
}

// checkTotals 纯判定：部门现有资料换上（或加上）s 之后，正文与原始字节合计是否超限。
func checkTotals(dept string, existing []materialSlot, s materialSlot) error {
	text, bin := s.units, s.bin
	for _, e := range existing {
		if s.id == "" || e.id != s.id {
			text, bin = text+e.units, bin+e.bin
		}
	}
	if text > MaxMaterial {
		return Full("materials", dept, text)
	}
	if bin > MaxMaterialBin<<20 {
		return Full("material_bin", dept, MB(bin))
	}
	return nil
}

const materialCols = `id, rev, department, kind, title, note, file, size, units, binary, archived_at, created_by, created_at`

// materialSelect 读资料：materialCols 加所属部门名称（表别名 m）。
const materialSelect = `SELECT ` + materialCols + `, (SELECT name FROM departments WHERE departments.id = m.department) FROM materials m`

func scanMaterial(s interface{ Scan(...any) error }, data string) (Material, error) {
	var m Material
	var binary bool
	var archived sql.NullInt64
	err := s.Scan(&m.ID, &m.Rev, &m.Org, &m.Kind, &m.Title, &m.Note, &m.Entry, &m.Size, &m.Units, &binary, &archived,
		&m.CreatedBy, &m.CreatedAt, &m.OrgName)
	if archived.Valid {
		m.ArchivedAt = &archived.Int64
	}
	m.Dir = filepath.Dir(materialFile(data, m.ID, m.Rev, "x"))
	return m, err
}

// materialFiles 取一批资料版本的文件清单（where 是对 materials m 的条件），按资料号归组。
func materialFiles(ctx context.Context, q store.Querier, where string, args []any) (map[string][]MaterialFileInfo, error) {
	rows, err := q.QueryContext(ctx, `SELECT f.id, f.path, f.size, f.units, f.binary FROM material_files f
		JOIN materials m ON m.id = f.id AND m.rev = f.rev WHERE `+where+` ORDER BY f.id, f.path LIMIT ?`,
		append(args, (ReadCap+1)*maxMaterialFiles)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]MaterialFileInfo{}
	for rows.Next() {
		var id string
		var f MaterialFileInfo
		if err := rows.Scan(&id, &f.Path, &f.Size, &f.Units, &f.Binary); err != nil {
			return nil, err
		}
		out[id] = append(out[id], f)
	}
	return out, rows.Err()
}

// MaterialFilter 是 material ls 的条件。
type MaterialFilter struct {
	Org      string
	Archived bool // 只列已归档的
}

// Materials 列资料的最新版：总览在前，其余按标题。
func Materials(ctx context.Context, q store.Querier, data string, f MaterialFilter) ([]Material, error) {
	// 条件都带表别名 m：取文件清单时同一组条件用在 material_files 联表上。
	where, args := []string{"m.rev = (SELECT max(rev) FROM materials WHERE id = m.id)"}, []any{}
	if f.Archived {
		where = append(where, "m.archived_at IS NOT NULL")
	} else {
		where = append(where, "m.archived_at IS NULL")
	}
	if f.Org != "" {
		where, args = append(where, "m.department = ?"), append(args, f.Org)
	}
	cond := strings.Join(where, " AND ")
	rows, err := q.QueryContext(ctx, materialSelect+` WHERE `+cond+
		` ORDER BY department, kind = 'detail', title LIMIT ?`, append(args, ReadCap+1)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Material{}
	for rows.Next() {
		m, err := scanMaterial(rows, data)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	files, err := materialFiles(ctx, q, cond, args)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Files = files[out[i].ID]
	}
	return out, capErr("资料", len(out))
}

// GetMaterial 取一份资料的某一版（rev 为 0 取最新）。
func GetMaterial(ctx context.Context, q store.Querier, data, id string, rev int) (Material, error) {
	query, args := materialSelect+` WHERE id = ? ORDER BY rev DESC LIMIT 1`, []any{id}
	if rev > 0 {
		query, args = materialSelect+` WHERE id = ? AND rev = ?`, []any{id, rev}
	}
	m, err := scanMaterial(q.QueryRowContext(ctx, query, args...), data)
	if store.IsNotFound(err) && rev > 0 {
		return Material{}, api.NotFound("资料 %s 不存在或没有第 %d 版", id, rev).WithNext("atrium material ls " + id)
	}
	if store.IsNotFound(err) {
		return Material{}, api.NotFound("资料 %s 不存在", id).WithNext("atrium material ls")
	}
	if err != nil {
		return m, err
	}
	files, err := materialFiles(ctx, q, "m.id = ? AND m.rev = ?", []any{m.ID, m.Rev})
	m.Files = files[m.ID]
	return m, err
}

// Overview 是负责人唤醒时附的部门总览全文；没有总览返回空串。
func Overview(ctx context.Context, q store.Querier, data, dept string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx, `SELECT id FROM materials WHERE department = ? AND kind = 'overview' AND archived_at IS NULL
		LIMIT 1`, dept).Scan(&id)
	if store.IsNotFound(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	m, err := GetMaterial(ctx, q, data, id, 0)
	if err != nil {
		return "", err
	}
	_, p, err := m.File("")
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(p)
	return string(raw), err
}

// insertMaterialRev 在事务里记一条资料的一版（materials 一行、material_files 每个文件一行）；文件内容由调用方写。
func insertMaterialRev(ctx context.Context, tx *sql.Tx, s materialSlot, dept, by string, at int64) error {
	entryBinary := false
	for _, f := range s.files {
		if f.Path == s.entry {
			entryBinary = f.Binary
		}
	}
	size := 0
	for _, f := range s.files {
		size += f.Size
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO materials (`+materialCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
		s.id, s.rev, dept, s.kind, s.title, s.note, s.entry, size, s.units, entryBinary, by, at); err != nil {
		return err
	}
	for _, f := range s.files {
		if _, err := tx.ExecContext(ctx, `INSERT INTO material_files (id, rev, path, size, units, binary) VALUES (?, ?, ?, ?, ?, ?)`,
			s.id, s.rev, f.Path, f.Size, f.Units, f.Binary); err != nil {
			return err
		}
	}
	return nil
}

// AddMaterial 按 PlanMaterial 在一个事务里新建一条（in.Org）或给 in.ID 加一版，写文件。已归档的要先撤销归档才能加版。
func AddMaterial(ctx context.Context, db *store.DB, data string, in MaterialInput, actor string) (Material, error) {
	if err := checkText("note", in.Note, maxMaterialNote, false); err != nil {
		return Material{}, err
	}
	var id string
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		if in.ID != "" {
			m, err := GetMaterial(ctx, tx, data, in.ID, 0)
			if err != nil {
				return err
			}
			if m.ArchivedAt != nil {
				return api.Conflict("%s 已归档：先撤销归档再加一版", in.ID).WithNext("atrium material archive " + in.ID + " --undo")
			}
			in.Org = m.Org
		} else if _, err := Get(ctx, tx, in.Org); err != nil {
			return err
		}
		cur, err := Materials(ctx, tx, data, MaterialFilter{Org: in.Org})
		if err != nil {
			return err
		}
		existing := make([]materialSlot, len(cur))
		for i, m := range cur {
			existing[i] = slotOf(m)
		}
		s, err := PlanMaterial(in.Org, existing, in)
		if err != nil {
			return err
		}
		if strings.TrimSpace(in.Note) != "" {
			s.note = in.Note
		} else if s.id == "" {
			return api.Usage("--note: %s 是新资料，要写它里面有什么、什么时候用", s.title)
		}
		if s.id == "" {
			if s.id, err = store.NextID(ctx, tx, "m"); err != nil {
				return err
			}
		}
		s.rev++
		if err := insertMaterialRev(ctx, tx, s, in.Org, actor, store.Now()); err != nil {
			return err
		}
		for _, f := range in.Files {
			if err := writeFile(materialFile(data, s.id, s.rev, f.Name), f.Content, 0o600); err != nil {
				return err
			}
		}
		id = s.id
		return nil
	})
	if err != nil {
		return Material{}, err
	}
	return GetMaterial(ctx, db, data, id, 0)
}

// ArchiveMaterial 归档（undo 为真时撤销归档）。归档的不算总量、不附给负责人，文件都留着；真删只有用户手动。
func ArchiveMaterial(ctx context.Context, db *store.DB, data, id string, undo bool) (Material, error) {
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		m, err := GetMaterial(ctx, tx, data, id, 0)
		if err != nil {
			return err
		}
		if (m.ArchivedAt != nil) != undo {
			if undo {
				return api.Conflict("%s 没有归档", id)
			}
			return api.Conflict("%s 已经归档", id)
		}
		if undo {
			cur, err := Materials(ctx, tx, data, MaterialFilter{Org: m.Org})
			if err != nil {
				return err
			}
			existing := make([]materialSlot, 0, len(cur))
			for _, c := range cur {
				if c.Kind == "overview" && m.Kind == "overview" {
					return api.Conflict("部门 %s 已有总览 %s：先归档它", m.Org, c.ID).WithNext("atrium material archive " + c.ID)
				}
				existing = append(existing, slotOf(c))
			}
			// 撤销归档按「加回这一份」查部门总量。
			if err := checkTotals(m.Org, existing, slotOf(m)); err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, `UPDATE materials SET archived_at = NULL WHERE id = ?`, id)
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE materials SET archived_at = ? WHERE id = ?`, store.Now(), id)
		return err
	})
	if err != nil {
		return Material{}, err
	}
	return GetMaterial(ctx, db, data, id, 0)
}

// MaterialContent 是 material ls mN[/相对路径] 的结果：资料的元数据与其中一个文件（缺省正文）的内容。
// 图片集没有正文，不给路径时 File 为空、没有内容。
type MaterialContent struct {
	Material
	File    *MaterialFileInfo `json:"file,omitempty"`
	Content []byte            `json:"content"`
}

func materialRoutes(r *api.Router, env *app.Env) {
	db, data := env.DB, env.Paths.Data
	r.Handle("GET /api/materials", func(q *api.Req) (any, error) {
		v := q.URL.Query()
		return Materials(q.Context(), db, data, MaterialFilter{Org: v.Get("node"), Archived: v.Get("archived") == "1"})
	})
	r.Handle("POST /api/materials", func(q *api.Req) (any, error) {
		var in MaterialInput
		if err := q.DecodeMax(&in, MaxMaterialBody); err != nil {
			return nil, err
		}
		return AddMaterial(q.Context(), db, data, in, q.Actor.ID)
	})
	r.Handle("POST /api/materials/{id}/revs", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "m")
		if err != nil {
			return nil, err
		}
		var in MaterialInput
		if err := q.DecodeMax(&in, MaxMaterialBody); err != nil {
			return nil, err
		}
		in.ID = id
		return AddMaterial(q.Context(), db, data, in, q.Actor.ID)
	})
	r.Handle("GET /api/materials/{id}", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "m")
		if err != nil {
			return nil, err
		}
		v := q.URL.Query()
		rev := 0
		if s := v.Get("rev"); s != "" {
			if rev, err = strconv.Atoi(s); err != nil || rev < 1 {
				return nil, api.Usage("--rev: 应为正整数")
			}
		}
		m, err := GetMaterial(q.Context(), db, data, id, rev)
		if err != nil {
			return nil, err
		}
		rel := v.Get("file")
		if rel == "" && m.Entry == "" {
			return MaterialContent{Material: m}, nil
		}
		f, p, err := m.File(rel)
		if err != nil {
			return nil, err
		}
		raw, err := os.ReadFile(p)
		return MaterialContent{Material: m, File: &f, Content: raw}, err
	})
	r.Handle("POST /api/materials/{id}/archive", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "m")
		if err != nil {
			return nil, err
		}
		return ArchiveMaterial(q.Context(), db, data, id, q.URL.Query().Get("undo") == "1")
	})
}

// readLocalMaterial 把命令行给的文件或目录读成一条资料：文件的标题是文件名；
// 目录的标题是目录名，文件是目录里的全部文件（跳过隐藏项），名字是相对这个目录的路径。
func readLocalMaterial(p string) (title string, files []MaterialFile, err error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", nil, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return "", nil, api.Usage("读不到 %s：%v", p, err)
	}
	title = filepath.Base(abs)
	if !st.IsDir() {
		raw, err := os.ReadFile(abs)
		return title, []MaterialFile{{Name: title, Content: raw}}, err
	}
	err = filepath.WalkDir(abs, func(f string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.HasPrefix(d.Name(), ".") && f != abs {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if len(files) >= maxMaterialFiles {
			return api.Usage("%s 里文件超过 %d 个：目录里只放这次要加的文件（如报告和它的图片），或分几条加", p, maxMaterialFiles)
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(abs, f)
		files = append(files, MaterialFile{Name: filepath.ToSlash(rel), Content: raw})
		return nil
	})
	return title, files, err
}

// materialAmount 纯函数：资料的量，如「9 个文件 · 1.5 万字 · 1.6 MB」；单个文件不写文件数。
func materialAmount(m Material) string {
	var parts []string
	if len(m.Files) > 1 {
		parts = append(parts, fmt.Sprintf("%d 个文件", len(m.Files)))
	}
	bin := m.rawBytes()
	if m.Units > 0 || bin == 0 {
		parts = append(parts, fmt.Sprintf("%d 字", m.Units))
	}
	if bin > 0 {
		parts = append(parts, fmt.Sprintf("%.1f MB", float64(bin)/(1<<20)))
	}
	return strings.Join(parts, " · ")
}

func materialLine(m Material) string {
	kind := "细节"
	if m.Kind == "overview" {
		kind = "总览"
	}
	s := fmt.Sprintf("%s  %s  %s  %s  第 %d 版", m.ID, kind, m.Title, materialAmount(m), m.Rev)
	if m.Note != "" {
		s += "  —— " + m.Note
	}
	return s
}

func materialCommands(t *cli.Table) {
	t.Group("material", "资料")
	t.Add(cli.Command{Path: "material add", Args: "<oN|mN> <文件或目录>",
		Summary: fmt.Sprintf("在部门 oN 新建一条资料，或给资料 mN 加一版（总览 ≤%d 字，部门文本合计 ≤%d 字；单个文件 ≤%d MB，部门原始字节合计 ≤%d MB）",
			MaxOverview, MaxMaterial, MaxMaterialFile, MaxMaterialBin),
		Detail: fmt.Sprintf(`传文件：这个文件是一条资料，标题是文件名。
传目录：整个目录是一条资料（跳过点开头的隐藏项），标题是目录名。正文按顺序认 report.md、README.md、index.html，
再认目录里唯一的 md 或 html；全是图片就是图片集；都认不出时用 --entry 指定。其余文件按相对路径跟着正文，
正文里的相对图片、链接在这条资料里找。目录要只放这条资料的东西：目录里还有别的（如克隆的仓库）就不要直接传它。
一条资料最多 %d 个文件、%d 层、合计 %d MB。
写 oN 永远新建一条，哪怕部门里已有同名资料；要改已有的资料，写它的 mN 加一版（类别、标题沿用，旧版都留着）。`, maxMaterialFiles, maxMaterialDepth, maxMaterialRequest>>20),
		Flags: []cli.Flag{
			{Name: "overview", Bool: true, Help: "新建的是部门总览（每次附给负责人；一个部门一份，已有时写它的 mN 加一版）"},
			{Name: "note", Value: "文字", Help: "资料里有什么、什么时候用；不写这一版改了什么。新建必填，给 mN 加一版时可省，省了沿用上一版的说明"},
			{Name: "entry", Value: "相对路径", Help: "目录资料的正文文件（认不出时要给）"},
		},
		Run: func(c *cli.Ctx) error {
			target, err := c.Arg(0, "<oN|mN>")
			if err != nil {
				return err
			}
			src, err := c.Arg(1, "<文件或目录>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(2); err != nil {
				return err
			}
			title, files, err := readLocalMaterial(src)
			if err != nil {
				return err
			}
			rev := strings.HasPrefix(target, "m")
			if rev && c.Bool("overview") {
				return api.Usage("--overview: 给 %s 加一版时类别跟着原资料，不用写", target)
			}
			in := MaterialInput{Title: title, Entry: c.Str("entry"), Files: files, Overview: c.Bool("overview"), Note: c.Str("note")}
			// 文件先在本地查一遍（大目录不白传）；是新建还是加版、部门总量由服务端判。
			if _, err := PlanMaterial("", nil, in); err != nil {
				return err
			}
			size := 0
			for _, f := range files {
				size += len(f.Content)
			}
			if size > maxMaterialRequest {
				return api.Usage("这条资料的文件合计 %d MB，超过一次上传的 %d MB：拆成几条加", MB(size), maxMaterialRequest>>20)
			}
			var m Material
			if rev {
				if err := c.Call("POST", "/api/materials/"+url.PathEscape(target)+"/revs", in, &m); err != nil {
					return err
				}
				return c.Done(m, "已给 "+m.ID+" 加一版："+materialLine(m), "atrium material ls --node "+m.Org)
			}
			in.Org = target
			if err := c.Call("POST", "/api/materials", in, &m); err != nil {
				return err
			}
			return c.Done(m, "已新建 "+materialLine(m), "atrium material ls --node "+m.Org)
		}})
	t.Add(cli.Command{Path: "material ls", Args: "[mN[/相对路径]]",
		Summary: "按部门列资料（--node 只看一个部门及用量）；给 mN 取正文，mN/<相对路径> 取资料里的其他文件",
		Flags: []cli.Flag{
			{Name: "node", Value: "oN", Help: "只看这个部门的"},
			{Name: "archived", Bool: true, Help: "只看已归档的"},
			{Name: "rev", Value: "N", Help: "给 mN 时取第几版（缺省最新）"},
			{Name: "out", Value: "文件", Help: "给 mN 时写到文件（二进制文件必须给）"},
		},
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			if len(c.Args) == 1 {
				return getMaterial(c, c.Args[0])
			}
			v := url.Values{}
			if n := c.Str("node"); n != "" {
				v.Set("node", n)
			}
			if c.Bool("archived") {
				v.Set("archived", "1")
			}
			var list []Material
			if err := c.Call("GET", "/api/materials?"+v.Encode(), nil, &list); err != nil {
				return err
			}
			var b strings.Builder
			if n := c.Str("node"); n != "" && !c.Bool("archived") {
				total, overview := 0, 0
				for _, m := range list {
					total += m.Units
					if m.Kind == "overview" {
						overview = m.Units
					}
				}
				fmt.Fprintf(&b, "部门 %s：总览 %d/%d 字，合计 %d/%d 字\n", n, overview, MaxOverview, total, MaxMaterial)
			}
			for i, m := range list {
				// 不限部门时按部门分组，部门号和名称作小标题（列表已按部门排序）
				if c.Str("node") == "" && (i == 0 || list[i-1].Org != m.Org) {
					fmt.Fprintf(&b, "%s %s\n", m.Org, m.OrgName)
				}
				b.WriteString("  " + materialLine(m) + "\n")
			}
			if len(list) == 0 {
				b.WriteString("没有资料\n")
				return c.Done(list, b.String(), "atrium material add <oN> <文件或目录> --note <是什么>")
			}
			return c.Done(list, b.String(), "atrium material ls "+list[0].ID)
		}})
	t.Add(cli.Command{Path: "material archive", Args: "<mN>", Summary: "归档资料（不算用量、不再附给负责人；文件留着）",
		Flags: []cli.Flag{{Name: "undo", Bool: true, Help: "撤销归档"}},
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<mN>")
			if err != nil {
				return err
			}
			q := ""
			if c.Bool("undo") {
				q = "?undo=1"
			}
			var m Material
			if err := c.Call("POST", "/api/materials/"+url.PathEscape(id)+"/archive"+q, nil, &m); err != nil {
				return err
			}
			verb := "已归档 "
			if c.Bool("undo") {
				verb = "已撤销归档 "
			}
			return c.Done(m, verb+materialLine(m), "atrium material ls --node "+m.Org)
		}})
}

// getMaterial 是 material ls mN[/相对路径]：取资料里的一个文件（缺省正文），文本直接输出原文。
// 图片集没有正文，列出其中的文件。
func getMaterial(c *cli.Ctx, arg string) error {
	rev, err := c.Int("rev", 0)
	if err != nil {
		return err
	}
	id, rel, _ := strings.Cut(arg, "/")
	v := url.Values{}
	if rev > 0 {
		v.Set("rev", strconv.Itoa(rev))
	}
	if rel != "" {
		v.Set("file", rel)
	}
	var m MaterialContent
	if err := c.Call("GET", "/api/materials/"+url.PathEscape(id)+"?"+v.Encode(), nil, &m); err != nil {
		return err
	}
	if m.File == nil {
		var b strings.Builder
		fmt.Fprintf(&b, "%s 是图片集，没有正文：\n", m.ID)
		for _, f := range m.Files {
			fmt.Fprintf(&b, "  %s  %.1f MB\n", f.Path, float64(f.Size)/(1<<20))
		}
		return c.Done(m.Material, b.String(), "atrium material ls "+m.ID+"/"+firstPath(m.Files)+" --out <文件>")
	}
	if out := c.Str("out"); out != "" {
		if err := os.WriteFile(out, m.Content, 0o600); err != nil {
			return err
		}
		return c.Done(m.Material, fmt.Sprintf("已写到 %s（%s 第 %d 版的 %s，%d 字节）", out, m.ID, m.Rev, m.File.Path, m.File.Size), "")
	}
	if m.File.Binary && !c.JSON {
		return api.Usage("%s 是二进制文件：用 --out <文件> 写到文件", arg)
	}
	// 取正文时提示资料里还有别的文件；取某个文件时只输出原文。
	next := ""
	if rel == "" && len(m.Files) > 1 {
		next = fmt.Sprintf("atrium material ls %s/<相对路径> 取这条资料里的其他 %d 个文件（material ls %s --json 看清单）", m.ID, len(m.Files)-1, m.ID)
	}
	return c.Done(m, string(m.Content), next)
}
