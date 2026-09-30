package org

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/gates/skillcheck"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 技能：一类活怎么干——SKILL.md（做法）、附属文件（文本或截图等二进制）、优先执行者、交付要查什么、要的凭据。
// 每次修改追加一版，文件在 skills/<名字>/r<rev>/。执行者、负责人、秘书在哪台机器上都用 atrium skill ls 取（SkillHowTo），
// 提示词里只给技能名，不给服务机上的路径。
// 大小与每层项数的上限（单个文件 MaxSkillFile、合计 MaxSkillTotal、每层 MaxSkillLayer）在上限表；文件总数不设限。
const (
	maxSkillDepth = 3
	keepSkillRevs = 10 // 每个技能留最近几版
	maxSummary    = 120
	// 请求体上限：文件合计上限经 base64 涨 1/3，再留 1MB 给其余字段。
	maxSkillRequest = MaxSkillTotal<<20/3*4 + 1<<20
)

type Skill struct {
	Name      string   `json:"name"`
	Rev       int      `json:"rev"`
	Summary   string   `json:"summary"`
	Files     int      `json:"files"`
	Workers   []string `json:"workers"`
	Checks    []string `json:"checks"`
	Secrets   []string `json:"secrets"`
	CreatedBy string   `json:"created_by"`
	CreatedAt int64    `json:"created_at"`
	Body      string   `json:"body,omitempty"` // 只在看单个技能时给
	Others    []string `json:"others,omitempty"`
}

// SkillInput 是 skill add 的输入：Files 为 nil 时沿用上一版的文件（JSON 里内容是 base64）；各列表为 nil 时沿用上一版。
type SkillInput struct {
	Name    string            `json:"name"`
	Files   map[string][]byte `json:"files,omitempty"`
	Workers *[]string         `json:"workers,omitempty"`
	Checks  *[]string         `json:"checks,omitempty"`
	Secrets *[]string         `json:"secrets,omitempty"`
}

var (
	slugRe  = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	tokenRe = regexp.MustCompile(`^[A-Za-z0-9._:+-]{1,64}$`)
)

// CheckSkillName 纯判定：小写字母、数字与单个连字符，1–64。
func CheckSkillName(name string) error {
	if len(name) > 64 || !slugRe.MatchString(name) {
		return api.Usage("技能名 %q 不合法：只能用小写字母、数字和单个连字符，如 web-design", name)
	}
	return nil
}

// CheckSkillFiles 纯判定：必须有 SKILL.md（文本，≤6KB），其余见 CheckSkillShape。附属文件可以是二进制。
func CheckSkillFiles(name string, files map[string][]byte) error {
	body, ok := files["SKILL.md"]
	if !ok {
		return api.Usage("技能缺少 SKILL.md")
	}
	if !IsText(body) {
		return api.Usage("files: SKILL.md 不是文本文件")
	}
	if len(body) > MaxSkillBody {
		return Full("skill_body", "", len(body))
	}
	sizes := make(map[string]int, len(files))
	for p, c := range files {
		sizes[p] = len(c)
	}
	return CheckSkillShape(name, sizes)
}

// CheckSkillShape 纯判定：技能各文件（相对路径 → 字节数）的路径与层深、单个与合计大小、每一层的项数。
// 只看路径和大小，命令行读本地目录时在读内容之前先用它判（readLocalSkill），服务端经 CheckSkillFiles 用同一份。
func CheckSkillShape(name string, sizes map[string]int) error {
	layers := map[string]map[string]bool{} // 目录（根为空串）→ 直接的文件与子文件夹
	total := 0
	for p, n := range sizes {
		if err := CheckRelPath("files", p, maxSkillDepth); err != nil {
			return err
		}
		if n > MaxSkillFile<<20 {
			return TooBig("skill_file", p, n)
		}
		total += n
		for dir, rest := "", p; ; {
			head, tail, more := strings.Cut(rest, "/")
			if layers[dir] == nil {
				layers[dir] = map[string]bool{}
			}
			layers[dir][head] = true
			if !more {
				break
			}
			dir, rest = dir+head+"/", tail
		}
	}
	if total > MaxSkillTotal<<20 {
		return TooBig("skill_total", name, total)
	}
	for _, dir := range slices.Sorted(maps.Keys(layers)) {
		if n := len(layers[dir]); n > MaxSkillLayer {
			where := " " + dir + " "
			if dir == "" {
				where = "根目录"
			}
			l := LimitOf("skill_layer")
			return api.Limit(l.Next, "技能 %s 的%s有 %d 项（直接的文件与子文件夹），每层上限 %d 项：%s", name, where, n, l.Max, l.Fix)
		}
	}
	return nil
}

func checkTokens(field string, list []string, check func(string) error) error {
	if len(list) > 16 {
		return api.Usage("--%s: 最多 16 项", field)
	}
	for _, v := range list {
		if err := check(v); err != nil {
			return err
		}
	}
	return nil
}

// checkName：技能的 checks 只能写 skillcheck 认得的检查名，写错当场报，不拖到关卡。
func checkName(v string) error {
	if err := skillcheck.Validate(v); err != nil {
		return api.Usage("--checks: %v", err)
	}
	return nil
}

func tokenCheck(field string) func(string) error {
	return func(v string) error {
		if !tokenRe.MatchString(v) {
			return api.Usage("--%s: %q 不合法（字母、数字与 ._:+-）", field, v)
		}
		return nil
	}
}

// SkillSummary 纯函数：一行说明取 frontmatter 的 description；没有就取第一行非空正文（去掉 #）。
func SkillSummary(body string) string {
	lines := strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n")
	start := 0
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "---" {
		for i := 1; i < len(lines); i++ {
			l := strings.TrimSpace(lines[i])
			if l == "---" {
				start = i + 1
				break
			}
			if v, ok := strings.CutPrefix(l, "description:"); ok && strings.TrimSpace(v) != "" {
				return clip(strings.Trim(strings.TrimSpace(v), `"'`), maxSummary)
			}
		}
	}
	for _, l := range lines[start:] {
		if l = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(l), "#")); l != "" {
			return clip(l, maxSummary)
		}
	}
	return ""
}

// SkillHowTo 是提示词里取技能的入口，索引与挂上的技能共用；附属文件和技能之间的相对链接怎么取在 skill ls 的回执里。
const SkillHowTo = "atrium skill ls <名字> 取做法与附属文件"

// SkillIndex 纯函数：全部技能的索引拼成提示词里的一节（名字、一句话），由读的人按手上的活用 SkillHowTo 自取。
// 执行者、负责人、秘书的提示词都从这里取（同 Principles）；except 是这件活已挂上的技能，另有「按这份做法干」，索引里不重复。没有技能为空。
// 技能总数有上限（MaxSkills），一行约两百字节，整节量级在 10KB 以内。
func SkillIndex(skills []Skill, except string) string {
	var b strings.Builder
	for _, k := range skills {
		if k.Name == except {
			continue
		}
		summary := k.Summary
		if summary == "" {
			summary = "（没有说明）"
		}
		fmt.Fprintf(&b, "- %s：%s\n", k.Name, summary)
	}
	if b.Len() == 0 {
		return ""
	}
	return "## 技能索引（Atrium 全部技能）\n\n跟这件活相关的先读再动手，" + SkillHowTo + "：\n\n" + b.String()
}

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}

func splitCSV(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

const skillCols = `name, rev, summary, files, workers, checks, secrets, created_by, created_at`

func scanSkill(s interface{ Scan(...any) error }) (Skill, error) {
	var k Skill
	var workers, checks, secrets string
	err := s.Scan(&k.Name, &k.Rev, &k.Summary, &k.Files, &workers, &checks, &secrets, &k.CreatedBy, &k.CreatedAt)
	k.Workers, k.Checks, k.Secrets = splitCSV(workers), splitCSV(checks), splitCSV(secrets)
	return k, err
}

// GetSkill 取技能的最新版（不含正文）。dispatch、gates 读优先执行者、交付要查什么、要的凭据用它。
func GetSkill(ctx context.Context, q store.Querier, name string) (Skill, error) {
	k, err := scanSkill(q.QueryRowContext(ctx, `SELECT `+skillCols+` FROM skills WHERE name = ? ORDER BY rev DESC LIMIT 1`, name))
	if store.IsNotFound(err) {
		return Skill{}, api.NotFound("技能 %s 不存在", name).WithNext("atrium skill ls")
	}
	return k, err
}

// Skills 列全部技能的最新版（按名字）。
func Skills(ctx context.Context, q store.Querier) ([]Skill, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+skillCols+` FROM skills s WHERE rev = (SELECT max(rev) FROM skills WHERE name = s.name)
		ORDER BY name LIMIT ?`, ReadCap+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Skill{}
	for rows.Next() {
		k, err := scanSkill(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, capErr("技能", len(out))
}

// ReadSkillFiles 读某一版的全部文件（相对路径 → 内容）。
func ReadSkillFiles(dir string) (map[string][]byte, error) {
	files := map[string][]byte{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		files[filepath.ToSlash(rel)] = raw
		return nil
	})
	return files, err
}

// SaveSkill 建技能或追加一版。
func SaveSkill(ctx context.Context, db *store.DB, data string, in SkillInput, actor string) (Skill, error) {
	if err := CheckSkillName(in.Name); err != nil {
		return Skill{}, err
	}
	for _, f := range []struct {
		name string
		v    *[]string
		ok   func(string) error
	}{{"workers", in.Workers, tokenCheck("workers")}, {"checks", in.Checks, checkName}, {"secrets", in.Secrets, CheckSecretName}} {
		if f.v != nil {
			if err := checkTokens(f.name, *f.v, f.ok); err != nil {
				return Skill{}, err
			}
		}
	}
	if in.Files != nil {
		if err := CheckSkillFiles(in.Name, in.Files); err != nil {
			return Skill{}, err
		}
	}
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		prev, err := GetSkill(ctx, tx, in.Name)
		isNew := false
		if isCode(err, "not_found") {
			isNew, err = true, nil
		}
		if err != nil {
			return err
		}
		files := in.Files
		if isNew {
			if files == nil {
				return api.Usage("新技能要给 SKILL.md 文件或技能目录")
			}
			var n int
			if err := tx.QueryRowContext(ctx, `SELECT count(DISTINCT name) FROM skills`).Scan(&n); err != nil {
				return err
			}
			if n >= MaxSkills {
				return Full("skills", "", n)
			}
		} else {
			if files == nil && in.Workers == nil && in.Checks == nil && in.Secrets == nil {
				return api.Usage("没有要改的：给新的文件或目录，或 --workers/--checks/--secrets").WithNext("atrium skill add --help")
			}
			if files == nil {
				if files, err = ReadSkillFiles(skillDir(data, prev.Name, prev.Rev)); err != nil {
					return err
				}
			}
		}
		pick := func(v *[]string, old []string) string {
			if v != nil {
				return strings.Join(*v, ",")
			}
			return strings.Join(old, ",")
		}
		rev := prev.Rev + 1
		if _, err := tx.ExecContext(ctx, `INSERT INTO skills (`+skillCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			in.Name, rev, SkillSummary(string(files["SKILL.md"])), len(files), pick(in.Workers, prev.Workers),
			pick(in.Checks, prev.Checks), pick(in.Secrets, prev.Secrets), actor, store.Now()); err != nil {
			return err
		}
		old := rev - keepSkillRevs
		if old >= 1 {
			if _, err := tx.ExecContext(ctx, `DELETE FROM skills WHERE name = ? AND rev <= ?`, in.Name, old); err != nil {
				return err
			}
		}
		dir := skillDir(data, in.Name, rev)
		for p, c := range files {
			if err := writeFile(filepath.Join(dir, filepath.FromSlash(p)), c, 0o600); err != nil {
				return err
			}
		}
		for r := old; r >= 1; r-- {
			d := skillDir(data, in.Name, r)
			if _, err := os.Stat(d); err != nil {
				break
			}
			if err := os.RemoveAll(d); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Skill{}, err
	}
	return GetSkill(ctx, db, in.Name)
}

// ShowSkill 取最新版并带上 SKILL.md 正文与附属文件清单。
func ShowSkill(ctx context.Context, q store.Querier, data, name string) (Skill, error) {
	k, err := GetSkill(ctx, q, name)
	if err != nil {
		return Skill{}, err
	}
	files, err := ReadSkillFiles(skillDir(data, k.Name, k.Rev))
	if err != nil {
		return Skill{}, err
	}
	k.Body = string(files["SKILL.md"])
	for p := range files {
		if p != "SKILL.md" {
			k.Others = append(k.Others, p)
		}
	}
	slices.Sort(k.Others)
	return k, nil
}

// SkillFile 是 skill ls <名字>/<相对路径> 的结果：最新版里的一个文件。
type SkillFile struct {
	Skill   string `json:"skill"`
	Rev     int    `json:"rev"`
	Path    string `json:"path"`
	Binary  bool   `json:"binary"`
	Content []byte `json:"content"`
}

// GetSkillFile 取技能最新版里的一个文件（相对技能目录）。
func GetSkillFile(ctx context.Context, q store.Querier, data, name, rel string) (SkillFile, error) {
	if err := CheckRelPath("file", rel, maxSkillDepth); err != nil {
		return SkillFile{}, err
	}
	k, err := GetSkill(ctx, q, name)
	if err != nil {
		return SkillFile{}, err
	}
	raw, err := os.ReadFile(filepath.Join(skillDir(data, k.Name, k.Rev), filepath.FromSlash(rel)))
	if errors.Is(err, fs.ErrNotExist) {
		return SkillFile{}, api.NotFound("技能 %s 第 %d 版没有 %s", k.Name, k.Rev, rel).WithNext("atrium skill ls " + k.Name)
	}
	return SkillFile{Skill: k.Name, Rev: k.Rev, Path: rel, Binary: !IsText(raw), Content: raw}, err
}

func skillRoutes(r *api.Router, env *app.Env) {
	db, data := env.DB, env.Paths.Data
	r.Handle("GET /api/skills", func(q *api.Req) (any, error) { return Skills(q.Context(), db) })
	r.Handle("GET /api/skills/{name}", func(q *api.Req) (any, error) {
		if rel := q.URL.Query().Get("file"); rel != "" {
			return GetSkillFile(q.Context(), db, data, q.PathValue("name"), rel)
		}
		return ShowSkill(q.Context(), db, data, q.PathValue("name"))
	})
	r.Handle("POST /api/skills", func(q *api.Req) (any, error) {
		if err := CheckUser(q.Actor, "改技能"); err != nil {
			return nil, err
		}
		var in SkillInput
		if err := q.DecodeMax(&in, maxSkillRequest); err != nil {
			return nil, err
		}
		return SaveSkill(q.Context(), db, data, in, q.Actor.ID)
	})
}

// readLocalSkill 把命令行给的 SKILL.md 文件或技能目录读成「相对路径 → 内容」（跳过隐藏文件与目录）。
// 先只列路径和大小按 CheckSkillShape 判，过了才读内容：给错目录或目录超大时不整个读进内存。
func readLocalSkill(name, path string) (map[string][]byte, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, api.Usage("读不到 %s：%v", path, err)
	}
	local := map[string]string{} // 相对路径 → 本地文件
	sizes := map[string]int{}
	if !st.IsDir() {
		local["SKILL.md"], sizes["SKILL.md"] = path, int(st.Size())
	} else if err := filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.HasPrefix(d.Name(), ".") && p != path {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(path, p)
		rel = filepath.ToSlash(rel)
		local[rel], sizes[rel] = p, int(info.Size())
		return nil
	}); err != nil {
		return nil, err
	}
	if err := CheckSkillShape(name, sizes); err != nil {
		return nil, err
	}
	files := make(map[string][]byte, len(local))
	for rel, p := range local {
		raw, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		files[rel] = raw
	}
	return files, nil
}

func skillCommands(t *cli.Table) {
	t.Group("skill", "技能")
	t.Add(cli.Command{Path: "skill add", Args: "<名字> [SKILL.md 或技能目录]",
		Summary: "建技能或改出新一版（不给文件就沿用上一版的文件）",
		Flags: []cli.Flag{
			{Name: "workers", Value: "执行者", Multi: true, Help: "优先的执行者，写法同 task run --worker（给空串清掉）"},
			{Name: "checks", Value: "检查", Multi: true, Help: "交付时运行时自己跑的检查：" + strings.Join(skillcheck.Known(), "、") + "（给空串清掉）"},
			{Name: "secrets", Value: "名称", Multi: true, Help: "这类活要的凭据名，派活时按任务部门往上找（给空串清掉）"},
		},
		Run: func(c *cli.Ctx) error {
			name, err := c.Arg(0, "<名字>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(2); err != nil {
				return err
			}
			in := SkillInput{Name: name}
			if len(c.Args) > 1 {
				if in.Files, err = readLocalSkill(name, c.Args[1]); err != nil {
					return err
				}
				if err := CheckSkillFiles(name, in.Files); err != nil { // 先在本地判，超了不必上传
					return err
				}
			}
			for _, f := range []struct {
				flag string
				dst  **[]string
			}{{"workers", &in.Workers}, {"checks", &in.Checks}, {"secrets", &in.Secrets}} {
				if c.Has(f.flag) {
					v := c.List(f.flag)
					if v == nil {
						v = []string{}
					}
					*f.dst = &v
				}
			}
			var k Skill
			if err := c.Call("POST", "/api/skills", in, &k); err != nil {
				return err
			}
			return c.Done(k, fmt.Sprintf("技能 %s 第 %d 版：%s", k.Name, k.Rev, k.Summary),
				"atrium task add <标题> --skill "+k.Name)
		}})
	t.Add(cli.Command{Path: "skill ls", Args: "[名字[/相对路径]]", Summary: "列技能；给名字看这一个的做法与附属文件清单，名字/<相对路径> 取附属文件",
		Flags: []cli.Flag{{Name: "out", Value: "文件", Help: "取附属文件时写到文件（二进制文件必须给）"}},
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			if len(c.Args) == 1 {
				if name, rel, ok := strings.Cut(c.Args[0], "/"); ok {
					return getSkillFile(c, name, rel)
				}
				var k Skill
				if err := c.Call("GET", "/api/skills/"+url.PathEscape(c.Args[0]), nil, &k); err != nil {
					return err
				}
				var b strings.Builder
				fmt.Fprintf(&b, "%s 第 %d 版（%s）\n", k.Name, k.Rev, k.CreatedBy)
				for _, kv := range [][2]string{{"优先执行者", strings.Join(k.Workers, "、")}, {"交付要查", strings.Join(k.Checks, "、")},
					{"要的凭据", strings.Join(k.Secrets, "、")}, {"附属文件", strings.Join(k.Others, "、")}} {
					if kv[1] != "" {
						fmt.Fprintf(&b, "%s：%s\n", kv[0], kv[1])
					}
				}
				if o := Over("skill_body", len(k.Body)); o != "" {
					fmt.Fprintf(&b, "SKILL.md %s B：%s\n", o, LimitOf("skill_body").Fix)
				}
				b.WriteString("\n" + k.Body)
				return c.Done(k, b.String(), skillFileHowTo(k.Name))
			}
			var list []Skill
			if err := c.Call("GET", "/api/skills", nil, &list); err != nil {
				return err
			}
			if len(list) == 0 {
				return c.Done(list, "还没有技能", "atrium skill add <名字> <SKILL.md 或技能目录>")
			}
			var b strings.Builder
			fmt.Fprintf(&b, "技能 %s：\n", Tally("skills", len(list)))
			for _, k := range list {
				fmt.Fprintf(&b, "  %s  %s（第 %d 版）\n", k.Name, k.Summary, k.Rev)
			}
			return c.Done(list, b.String(), "atrium skill ls "+list[0].Name)
		}})
}

// skillFileHowTo 是 skill ls <名字> 回执的下一步：附属文件和做法里的相对链接都按技能目录取，在哪台机器上都一样。
func skillFileHowTo(name string) string {
	return "atrium skill ls " + name + "/<相对路径> 取附属文件（二进制加 --out 文件）；做法里链到 ../<别的技能>/<路径> 的，用 atrium skill ls <别的技能>/<路径>"
}

// getSkillFile 是 skill ls <名字>/<相对路径>：文本直接输出原文，二进制要 --out。
func getSkillFile(c *cli.Ctx, name, rel string) error {
	var f SkillFile
	if err := c.Call("GET", "/api/skills/"+url.PathEscape(name)+"?"+url.Values{"file": {rel}}.Encode(), nil, &f); err != nil {
		return err
	}
	if out := c.Str("out"); out != "" {
		if err := os.WriteFile(out, f.Content, 0o600); err != nil {
			return err
		}
		return c.Done(f, fmt.Sprintf("已写到 %s（技能 %s 第 %d 版的 %s，%d 字节）", out, f.Skill, f.Rev, f.Path, len(f.Content)), "")
	}
	if f.Binary && !c.JSON {
		return api.Usage("%s/%s 是二进制文件：用 --out <文件> 写到文件", name, rel)
	}
	return c.Done(f, string(f.Content), "")
}
