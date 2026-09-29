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
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 资料：部门的知识分两层——一份「总览」（每次附给负责人，≤MaxOverview 字）与按需取的细节文件。
// 整个部门没归档的资料：文本合计 ≤MaxMaterial 字，二进制合计 ≤MaxMaterialBin MB，单个文件 ≤MaxMaterialFile MB。内容在 materials/<mN>/r<rev>/，改了追加一版。
const (
	maxMaterialNote  = 200
	maxMaterialFiles = 50
	maxMaterialDepth = 4
	// 一次上传的原始字节上限（JSON 里 base64 再涨 1/3，请求体上限按它放宽）。
	maxMaterialRequest = 2 * MaxMaterialFile << 20
	// MaxMaterialBody 是资料上传接口的请求体上限，也是所有接口里最大的（负责人权限判定先读全请求体，按它读）。
	MaxMaterialBody = maxMaterialRequest/3*4 + 1<<20
)

// Units 纯函数：资料的字数。文本（合法 UTF-8、无 NUL）按字（rune）数；二进制（图片等）不折算字数，
// 记 0，另按字节数计入二进制总量。
func Units(content []byte) (units int, binary bool) {
	if IsText(content) {
		return utf8.RuneCount(content), false
	}
	return 0, true
}

type Material struct {
	ID         string `json:"id"`
	Rev        int    `json:"rev"`
	Org        string `json:"org"`
	Kind       string `json:"kind"` // overview 或 detail
	Title      string `json:"title"`
	Note       string `json:"note"`
	Size       int    `json:"size"`
	Units      int    `json:"units"`
	Binary     bool   `json:"binary"`
	ArchivedAt *int64 `json:"archived_at,omitempty"`
	CreatedBy  string `json:"created_by"`
	CreatedAt  int64  `json:"created_at"`
	Path       string `json:"path"` // 内容文件的绝对路径（本机）
}

type MaterialFile struct {
	Name    string `json:"name"`    // 目录内相对路径，作资料标题
	Content []byte `json:"content"` // JSON 里是 base64
}

// MaterialInput 是 material add 的输入：Overview 时只能一个文本文件。
type MaterialInput struct {
	Org      string         `json:"org"`
	Files    []MaterialFile `json:"files"`
	Overview bool           `json:"overview"`
	Note     string         `json:"note"`
}

// MaterialPlan 纯判定用：部门现有资料（最新版、没归档的）。
type materialSlot struct {
	id, kind, title  string
	units, size, rev int
	binary           bool
}

// PlanMaterials 纯判定：每个文件是新建（id 空）还是给已有资料追加一版，以及加完后部门总量是否超限。
// 总览同一部门只有一份，再加就是它的新一版；细节按标题认同一份。
func PlanMaterials(dept string, existing []materialSlot, in MaterialInput) ([]materialSlot, error) {
	text, bin := 0, 0
	tally := func(s materialSlot, sign int) {
		if s.binary {
			bin += sign * s.size
		} else {
			text += sign * s.units
		}
	}
	for _, e := range existing {
		tally(e, 1)
	}
	var plan []materialSlot
	seen := map[string]bool{}
	for _, f := range in.Files {
		if seen[f.Name] {
			return nil, api.Usage("文件 %s 重复", f.Name)
		}
		seen[f.Name] = true
		if len(f.Content) > MaxMaterialFile<<20 {
			return nil, TooBig("material_file", f.Name, len(f.Content))
		}
		units, binary := Units(f.Content)
		kind := "detail"
		if in.Overview {
			kind = "overview"
			if binary {
				return nil, api.Usage("总览要是文本文件：%s 不是", f.Name)
			}
			if units > MaxOverview {
				return nil, Full("overview", dept, units)
			}
		}
		slot := materialSlot{kind: kind, title: f.Name, units: units, size: len(f.Content), binary: binary}
		for _, e := range existing {
			if e.kind == kind && (kind == "overview" || e.title == f.Name) {
				slot.id, slot.rev = e.id, e.rev
				tally(e, -1)
			}
		}
		tally(slot, 1)
		plan = append(plan, slot)
	}
	if text > MaxMaterial {
		return nil, Full("materials", dept, text)
	}
	if bin > MaxMaterialBin<<20 {
		return nil, Full("material_bin", dept, MB(bin))
	}
	return plan, nil
}

const materialCols = `id, rev, department, kind, title, note, file, size, units, binary, archived_at, created_by, created_at`

func scanMaterial(s interface{ Scan(...any) error }, data string) (Material, error) {
	var m Material
	var file string
	var archived sql.NullInt64
	err := s.Scan(&m.ID, &m.Rev, &m.Org, &m.Kind, &m.Title, &m.Note, &file, &m.Size, &m.Units, &m.Binary, &archived,
		&m.CreatedBy, &m.CreatedAt)
	if archived.Valid {
		m.ArchivedAt = &archived.Int64
	}
	m.Path = materialFile(data, m.ID, m.Rev, file)
	return m, err
}

// MaterialFilter 是 material ls 的条件。
type MaterialFilter struct {
	Org      string
	Archived bool // 只列已归档的
}

// Materials 列资料的最新版：总览在前，其余按标题。
func Materials(ctx context.Context, q store.Querier, data string, f MaterialFilter) ([]Material, error) {
	where, args := []string{"rev = (SELECT max(rev) FROM materials WHERE id = m.id)"}, []any{}
	if f.Archived {
		where = append(where, "archived_at IS NOT NULL")
	} else {
		where = append(where, "archived_at IS NULL")
	}
	if f.Org != "" {
		where, args = append(where, "department = ?"), append(args, f.Org)
	}
	rows, err := q.QueryContext(ctx, `SELECT `+materialCols+` FROM materials m WHERE `+strings.Join(where, " AND ")+
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
	return out, capErr("资料", len(out))
}

// GetMaterial 取一份资料的某一版（rev 为 0 取最新）。
func GetMaterial(ctx context.Context, q store.Querier, data, id string, rev int) (Material, error) {
	query, args := `SELECT `+materialCols+` FROM materials WHERE id = ? ORDER BY rev DESC LIMIT 1`, []any{id}
	if rev > 0 {
		query, args = `SELECT `+materialCols+` FROM materials WHERE id = ? AND rev = ?`, []any{id, rev}
	}
	m, err := scanMaterial(q.QueryRowContext(ctx, query, args...), data)
	if store.IsNotFound(err) {
		return Material{}, api.NotFound("资料 %s 不存在（或没有第 %d 版）", id, rev).WithNext("atrium material ls")
	}
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
	raw, err := os.ReadFile(m.Path)
	return string(raw), err
}

// AddMaterials 按 PlanMaterials 在一个事务里新建或追加一版，写文件。
func AddMaterials(ctx context.Context, db *store.DB, data string, in MaterialInput, actor string) ([]Material, error) {
	if len(in.Files) == 0 {
		return nil, api.Usage("没有文件")
	}
	if len(in.Files) > maxMaterialFiles {
		return nil, api.Usage("一次最多 %d 个文件", maxMaterialFiles)
	}
	if in.Overview && len(in.Files) != 1 {
		return nil, api.Usage("--overview: 总览只能是一个文件")
	}
	if err := checkText("note", in.Note, maxMaterialNote, true); err != nil {
		return nil, err
	}
	for _, f := range in.Files {
		if err := CheckRelPath("files", f.Name, maxMaterialDepth); err != nil {
			return nil, err
		}
	}
	var ids []string
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := Get(ctx, tx, in.Org); err != nil {
			return err
		}
		cur, err := Materials(ctx, tx, data, MaterialFilter{Org: in.Org})
		if err != nil {
			return err
		}
		existing := make([]materialSlot, len(cur))
		for i, m := range cur {
			existing[i] = materialSlot{id: m.ID, kind: m.Kind, title: m.Title, units: m.Units, size: m.Size, binary: m.Binary, rev: m.Rev}
		}
		plan, err := PlanMaterials(in.Org, existing, in)
		if err != nil {
			return err
		}
		for i, s := range plan {
			f := in.Files[i]
			if s.id == "" {
				if s.id, err = store.NextID(ctx, tx, "m"); err != nil {
					return err
				}
			}
			file := path.Base(f.Name)
			if _, err := tx.ExecContext(ctx, `INSERT INTO materials (`+materialCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
				s.id, s.rev+1, in.Org, s.kind, f.Name, in.Note, file, s.size, s.units, s.binary, actor, store.Now()); err != nil {
				return err
			}
			if err := writeFile(materialFile(data, s.id, s.rev+1, file), f.Content, 0o600); err != nil {
				return err
			}
			ids = append(ids, s.id)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	out := make([]Material, 0, len(ids))
	for _, id := range ids {
		m, err := GetMaterial(ctx, db, data, id, 0)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
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
				existing = append(existing, materialSlot{id: c.ID, kind: c.Kind, title: c.Title, units: c.Units, size: c.Size, binary: c.Binary})
			}
			// 撤销归档按「加回这一份」走同一个判定；它的内容取自己的文件。
			content, err := os.ReadFile(m.Path)
			if err != nil {
				return err
			}
			if _, err := PlanMaterials(m.Org, existing, MaterialInput{Overview: m.Kind == "overview",
				Files: []MaterialFile{{Name: "\x00" + m.ID, Content: content}}}); err != nil {
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

// MaterialContent 是 material ls mN 的结果。
type MaterialContent struct {
	Material
	Content []byte `json:"content"`
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
		return AddMaterials(q.Context(), db, data, in, q.Actor.ID)
	})
	r.Handle("GET /api/materials/{id}", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "m")
		if err != nil {
			return nil, err
		}
		rev := 0
		if s := q.URL.Query().Get("rev"); s != "" {
			if rev, err = strconv.Atoi(s); err != nil || rev < 1 {
				return nil, api.Usage("--rev: 应为正整数")
			}
		}
		m, err := GetMaterial(q.Context(), db, data, id, rev)
		if err != nil {
			return nil, err
		}
		raw, err := os.ReadFile(m.Path)
		return MaterialContent{Material: m, Content: raw}, err
	})
	r.Handle("POST /api/materials/{id}/archive", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "m")
		if err != nil {
			return nil, err
		}
		return ArchiveMaterial(q.Context(), db, data, id, q.URL.Query().Get("undo") == "1")
	})
}

// readLocalMaterials 把命令行给的文件或目录读成资料文件（目录里跳过隐藏项）。
func readLocalMaterials(p string) ([]MaterialFile, error) {
	st, err := os.Stat(p)
	if err != nil {
		return nil, api.Usage("读不到 %s：%v", p, err)
	}
	if !st.IsDir() {
		raw, err := os.ReadFile(p)
		return []MaterialFile{{Name: filepath.Base(p), Content: raw}}, err
	}
	var out []MaterialFile
	err = filepath.WalkDir(p, func(f string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.HasPrefix(d.Name(), ".") && f != p {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if len(out) >= maxMaterialFiles {
			return api.Usage("%s 里文件超过 %d 个：目录里只放这次要加的文件（如报告和它的图片），或分几次加", p, maxMaterialFiles)
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(p, f)
		out = append(out, MaterialFile{Name: filepath.ToSlash(rel), Content: raw})
		return nil
	})
	return out, err
}

func materialLine(m Material) string {
	kind := "细节"
	if m.Kind == "overview" {
		kind = "总览"
	}
	amount := fmt.Sprintf("%d 字", m.Units)
	if m.Binary {
		amount = fmt.Sprintf("%.1f MB", float64(m.Size)/(1<<20))
	}
	s := fmt.Sprintf("%s  %s  %s  %s  第 %d 版", m.ID, kind, m.Title, amount, m.Rev)
	if m.Note != "" {
		s += "  —— " + m.Note
	}
	return s
}

func materialCommands(t *cli.Table) {
	t.Group("material", "资料")
	t.Add(cli.Command{Path: "material add", Args: "<oN> <文件或目录>",
		Summary: fmt.Sprintf("加资料或给同名资料追加一版（总览 ≤%d 字，部门文本合计 ≤%d 字；单个文件 ≤%d MB，部门二进制合计 ≤%d MB）",
			MaxOverview, MaxMaterial, MaxMaterialFile, MaxMaterialBin),
		Detail: fmt.Sprintf(`传文件：加这一个文件，标题是文件名。
传目录：加目录里全部文件（跳过点开头的隐藏项），标题是相对这个目录的路径，如 report.md、images/arch.png；
报告按相对路径引用的图片，网页预览照这个标题找。
目录要只放这次要加的东西：报告和它引用的图片先放进单独的目录再传；目录里还有别的（如克隆的仓库）就不要直接传它。
一次最多 %d 个文件、%d 层、合计 %d MB。同一部门里标题相同就是给那份资料追加一版。`, maxMaterialFiles, maxMaterialDepth, maxMaterialRequest>>20),
		Flags: []cli.Flag{
			{Name: "overview", Bool: true, Help: "这是部门总览（每次附给负责人；一个部门一份）"},
			{Name: "note", Value: "文字", Help: "这份资料是什么、什么时候用（必填）"},
		},
		Run: func(c *cli.Ctx) error {
			dept, err := c.Arg(0, "<oN>")
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
			files, err := readLocalMaterials(src)
			if err != nil {
				return err
			}
			if _, err := PlanMaterials(dept, nil, MaterialInput{Files: files, Overview: c.Bool("overview")}); err != nil {
				return err
			}
			size := 0
			for _, f := range files {
				size += len(f.Content)
			}
			if size > maxMaterialRequest {
				return api.Usage("一次加的文件合计 %d MB，超过一次上传的 %d MB：分几次加", MB(size), maxMaterialRequest>>20)
			}
			var list []Material
			in := MaterialInput{Org: dept, Files: files, Overview: c.Bool("overview"), Note: c.Str("note")}
			if err := c.Call("POST", "/api/materials", in, &list); err != nil {
				return err
			}
			var b strings.Builder
			for _, m := range list {
				b.WriteString("已加 " + materialLine(m) + "\n")
			}
			return c.Done(list, b.String(), "atrium material ls --node "+dept)
		}})
	t.Add(cli.Command{Path: "material ls", Read: true, Args: "[mN]", Summary: "列资料与部门用量；给 mN 取这一份的内容",
		Flags: []cli.Flag{
			{Name: "node", Value: "oN", Help: "只看这个部门的"},
			{Name: "archived", Bool: true, Help: "只看已归档的"},
			{Name: "rev", Value: "N", Help: "给 mN 时取第几版（缺省最新）"},
			{Name: "out", Value: "文件", Help: "给 mN 时写到文件（二进制资料必须给）"},
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
			for _, m := range list {
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

// getMaterial 是 material ls mN：取一份资料的内容，文本直接输出原文。
func getMaterial(c *cli.Ctx, id string) error {
	rev, err := c.Int("rev", 0)
	if err != nil {
		return err
	}
	var m MaterialContent
	q := ""
	if rev > 0 {
		q = "?rev=" + strconv.Itoa(rev)
	}
	if err := c.Call("GET", "/api/materials/"+url.PathEscape(id)+q, nil, &m); err != nil {
		return err
	}
	if out := c.Str("out"); out != "" {
		if err := os.WriteFile(out, m.Content, 0o600); err != nil {
			return err
		}
		return c.Done(m.Material, fmt.Sprintf("已写到 %s（%s 第 %d 版，%d 字节）", out, m.ID, m.Rev, m.Size), "")
	}
	if m.Binary && !c.JSON {
		return api.Usage("%s 是二进制资料：用 --out <文件> 写到文件", id)
	}
	return c.Done(m, string(m.Content), "")
}
