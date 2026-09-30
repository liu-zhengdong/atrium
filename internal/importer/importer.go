package importer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// Item 是回执里的一类：导入多少、跳过多少、为什么。
type Item struct {
	Kind     string   `json:"kind"`
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Notes    []string `json:"notes,omitempty"`
}

// Report 是一次导入的回执。Over 是超了上限、照样导入但要用户整理的地方。
type Report struct {
	From     string           `json:"from"`
	Items    []Item           `json:"items"`
	Over     []string         `json:"over,omitempty"`
	Counters map[string]int64 `json:"counters"`
}

// Run 从旧库 from（只读打开）导入到 db；dataDir 是新数据目录（资料文件拷到这里）。
// 新库已有数据时拒绝；整个导入在一个事务里，出错全部回滚（资料文件先拷到临时目录，提交后才改名）。
func Run(ctx context.Context, from string, db *store.DB, dataDir string) (Report, error) {
	rep := Report{From: from, Counters: map[string]int64{}}
	if _, err := os.Stat(from); err != nil {
		return rep, api.NotFound("--from: 找不到旧库 %s", from)
	}
	if err := checkEmpty(ctx, db); err != nil {
		return rep, err
	}
	old, err := sql.Open("sqlite", "file:"+from+"?"+url.Values{"mode": {"ro"}}.Encode())
	if err != nil {
		return rep, err
	}
	defer old.Close()
	if err := old.PingContext(ctx); err != nil {
		return rep, fmt.Errorf("只读打开旧库失败：%w", err)
	}
	stage, err := os.MkdirTemp(dataDir, "import-")
	if err != nil {
		return rep, err
	}
	defer os.RemoveAll(stage)
	err = db.Tx(ctx, func(tx *sql.Tx) error {
		depts, err := importDepts(ctx, old, tx, &rep)
		if err != nil {
			return err
		}
		// 计数器先接上旧库：目录资料拆出来的文件要发新短号，不能撞旧号。
		steps := []func() error{
			func() error { return setCounters(ctx, old, tx, &rep) },
			func() error { return importRepos(ctx, old, tx, depts, &rep) },
			func() error { return importPoints(ctx, old, tx, depts, &rep) },
			func() error { return importLeaders(ctx, old, tx, &rep) },
			func() error { return importMemos(ctx, old, tx, &rep) },
			func() error { return importSkills(ctx, old, tx, stage, &rep) },
			func() error { return importMaterials(ctx, old, tx, depts, filepath.Dir(from), stage, &rep) },
			func() error { return importProfiles(ctx, old, tx, &rep) },
			func() error { return importHosts(ctx, old, tx, &rep) },
		}
		for _, s := range steps {
			if err := s(); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return rep, err
	}
	// 文件落位：stage/<skills|materials>/<名字> → 数据目录同名处（新库是空的，目标不该已存在）。
	for _, kind := range []string{"skills", "materials"} {
		entries, err := os.ReadDir(filepath.Join(stage, kind))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return rep, err
		}
		if err := os.MkdirAll(filepath.Join(dataDir, kind), 0o700); err != nil {
			return rep, err
		}
		for _, e := range entries {
			if err := os.Rename(filepath.Join(stage, kind, e.Name()), filepath.Join(dataDir, kind, e.Name())); err != nil {
				return rep, fmt.Errorf("文件落位失败（库已写入，请删掉新数据目录重来）：%w", err)
			}
		}
	}
	return rep, nil
}

// checkEmpty：新库只能有建库时插入的两个身份；开发期不做合并。
func checkEmpty(ctx context.Context, db *store.DB) error {
	var busy []string
	for _, t := range []string{"departments", "points", "memos", "skills", "materials",
		"worker_profiles", "hosts", "tasks", "choices", "schedules", "ids"} {
		var n int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM `+t).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			busy = append(busy, fmt.Sprintf("%s %d 行", t, n))
		}
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM identities WHERE id NOT IN ('u1', 'secretary')`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		busy = append(busy, fmt.Sprintf("identities %d 行", n))
	}
	if len(busy) > 0 {
		return api.Conflict("新库已有数据（%s），只能导入到空库；换一个空的 ATRIUM_DATA 再导", strings.Join(busy, "、"))
	}
	return nil
}

func add(rep *Report, it Item) { rep.Items = append(rep.Items, it) }

func importDepts(ctx context.Context, old *sql.DB, tx *sql.Tx, rep *Report) (map[string]bool, error) {
	rows, err := old.QueryContext(ctx, `SELECT n.id, n.parent_id, n.name, n.archived_at IS NOT NULL,
		COALESCE((SELECT fields FROM org_docs d WHERE d.node_id = n.id AND d.doc = 'charter'), '')
		FROM org_nodes n ORDER BY n.id LIMIT 10000`)
	if err != nil {
		return nil, err
	}
	var nodes []oldNode
	for rows.Next() {
		var n oldNode
		var parent sql.NullInt64
		if err := rows.Scan(&n.ID, &parent, &n.Name, &n.Archived, &n.Fields); err != nil {
			rows.Close()
			return nil, err
		}
		if parent.Valid {
			n.Parent = &parent.Int64
		}
		nodes = append(nodes, n)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	depts, skipped, err := planDepts(nodes)
	if err != nil {
		return nil, err
	}
	now := store.Now()
	kept := map[string]bool{}
	for _, d := range depts {
		if _, err := tx.ExecContext(ctx, `INSERT INTO departments (id, parent, name, what, uses, now, next, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, d.ID, store.Null(d.Parent), d.Name, d.What, d.Uses, d.Now, d.Next, now, now); err != nil {
			return nil, fmt.Errorf("写部门 %s：%w", d.ID, err)
		}
		kept[d.ID] = true
	}
	add(rep, Item{Kind: "部门", Imported: len(depts), Skipped: len(skipped), Notes: skipped})
	for _, l := range longIntros(depts) {
		rep.Over = append(rep.Over, "部门介绍超过 300 字："+l)
	}
	return kept, nil
}

func importRepos(ctx context.Context, old *sql.DB, tx *sql.Tx, depts map[string]bool, rep *Report) error {
	rows, err := old.QueryContext(ctx, `SELECT node_id, repo FROM org_node_repos ORDER BY node_id, repo LIMIT 10000`)
	if err != nil {
		return err
	}
	defer rows.Close()
	it := Item{Kind: "部门仓库"}
	for rows.Next() {
		var node int64
		var repo string
		if err := rows.Scan(&node, &repo); err != nil {
			return err
		}
		dept := fmt.Sprintf("o%d", node)
		if !depts[dept] {
			it.Skipped++
			it.Notes = append(it.Notes, dept+" 没导入："+repo)
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO department_repos (department, repo) VALUES (?, ?)`, dept, repo); err != nil {
			return err
		}
		it.Imported++
	}
	add(rep, it)
	return rows.Err()
}

func importPoints(ctx context.Context, old *sql.DB, tx *sql.Tx, depts map[string]bool, rep *Report) error {
	rows, err := old.QueryContext(ctx, `SELECT id, node_id, pos, text, why, decided_by, COALESCE(check_ref, ''), updated_by, updated_at
		FROM org_points ORDER BY id LIMIT 100000`)
	if err != nil {
		return err
	}
	var list []oldPoint
	for rows.Next() {
		var p oldPoint
		if err := rows.Scan(&p.ID, &p.Node, &p.Pos, &p.Text, &p.Why, &p.By, &p.Check, &p.UpdateBy, &p.UpdatedAt); err != nil {
			rows.Close()
			return err
		}
		list = append(list, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	points, skipped, over := planPoints(list, depts)
	for _, p := range points {
		if _, err := tx.ExecContext(ctx, `INSERT INTO points (id, department, pos, text, why, decided_by, check_ref, updated_by, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, p.ID, p.Dept, p.Pos, p.Text, p.Why, p.By, p.Check, p.UBy, p.UpdatedAt); err != nil {
			return fmt.Errorf("写要点 %s：%w", p.ID, err)
		}
	}
	add(rep, Item{Kind: "要点", Imported: len(points), Skipped: len(skipped), Notes: skipped})
	for _, o := range over {
		rep.Over = append(rep.Over, "要点超过每部门 7 条："+o)
	}
	return nil
}

func importLeaders(ctx context.Context, old *sql.DB, tx *sql.Tx, rep *Report) error {
	rows, err := old.QueryContext(ctx, `SELECT id, name, worker, created_at FROM org_leaders ORDER BY id LIMIT 10000`)
	if err != nil {
		return err
	}
	defer rows.Close()
	it := Item{Kind: "负责人"}
	for rows.Next() {
		var id, at int64
		var name, worker string
		if err := rows.Scan(&id, &name, &worker, &at); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO identities (id, kind, name, workers, created_at) VALUES (?, 'leader', ?, ?, ?)`,
			fmt.Sprintf("a%d", id), name, worker, at); err != nil {
			return err
		}
		it.Imported++
	}
	if it.Imported > 0 {
		it.Notes = append(it.Notes, "旧库里负责人都没挂部门（org_nodes.leader 为空），导入后部门仍由你直接管；要挂用 atrium org edit oN --leader aN")
	}
	add(rep, it)
	return rows.Err()
}

func importMemos(ctx context.Context, old *sql.DB, tx *sql.Tx, rep *Report) error {
	rows, err := old.QueryContext(ctx, `SELECT owner, body, updated_at FROM memos ORDER BY owner LIMIT 10000`)
	if err != nil {
		return err
	}
	defer rows.Close()
	it := Item{Kind: "备忘"}
	for rows.Next() {
		var owner, body string
		var at int64
		if err := rows.Scan(&owner, &body, &at); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM identities WHERE id = ?`, owner).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			it.Skipped++
			it.Notes = append(it.Notes, owner+" 不是已导入的身份")
			continue
		}
		if l := len([]rune(body)); l > org.MaxMemo {
			rep.Over = append(rep.Over, fmt.Sprintf("备忘超过 %d 字：%s %d 字", org.MaxMemo, owner, l))
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO memos (identity, body, updated_by, updated_at) VALUES (?, ?, ?, ?)`,
			owner, body, owner, at); err != nil {
			return err
		}
		it.Imported++
	}
	add(rep, it)
	return rows.Err()
}

// importSkills 搬每个技能的当前版：全部文件（SKILL.md 与附属文件）写到 stage/skills/<名字>/r<rev>/，
// 与 org 的技能目录同一布局；提交后整目录挪到数据目录。
func importSkills(ctx context.Context, old *sql.DB, tx *sql.Tx, stage string, rep *Report) error {
	rows, err := old.QueryContext(ctx, `SELECT slug, rev, files, archived_at IS NOT NULL, updated_at FROM org_skills ORDER BY id LIMIT 10000`)
	if err != nil {
		return err
	}
	defer rows.Close()
	it := Item{Kind: "技能"}
	for rows.Next() {
		var slug, raw string
		var rev, at int64
		var archived bool
		if err := rows.Scan(&slug, &rev, &raw, &archived, &at); err != nil {
			return err
		}
		if archived {
			it.Skipped++
			it.Notes = append(it.Notes, slug+" 已归档")
			continue
		}
		files, err := skillFiles(raw)
		if err != nil {
			return fmt.Errorf("技能 %s：%w", slug, err)
		}
		if !safeRel(slug) || strings.Contains(slug, "/") {
			return fmt.Errorf("技能名 %q 不能当目录名", slug)
		}
		dir := filepath.Join(stage, "skills", slug, fmt.Sprintf("r%d", rev))
		for p, body := range files {
			if err := writeNew(filepath.Join(dir, filepath.FromSlash(p)), []byte(body)); err != nil {
				return fmt.Errorf("技能 %s：%w", slug, err)
			}
		}
		if n := len(files["SKILL.md"]); n > org.MaxSkillBody {
			rep.Over = append(rep.Over, fmt.Sprintf("技能 SKILL.md 超过 6KB：%s %d 字节", slug, n))
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO skills (name, rev, summary, files, created_by, created_at) VALUES (?, ?, ?, ?, 'u1', ?)`,
			slug, rev, org.SkillSummary(files["SKILL.md"]), len(files), at); err != nil {
			return err
		}
		it.Imported++
	}
	add(rep, it)
	return rows.Err()
}

// importMaterials 搬当前版本（没被新版本取代、没归档），保留原短号。目录资料还是一条：标题是原名称，
// 文件按目录内相对路径放，正文按 org.PickEntry 认（认不出就没有正文，打开列出全部文件）。
// 文件写到 stage/materials/<mN>/r<rev>/<相对路径>，提交后挪到数据目录。
func importMaterials(ctx context.Context, old *sql.DB, tx *sql.Tx, depts map[string]bool, oldData, stage string, rep *Report) error {
	rows, err := old.QueryContext(ctx, `SELECT m.id, m.node_id, m.name, m.note, m.version, m.created_by, m.created_at,
		m.archived_at IS NOT NULL, m.superseded_by IS NOT NULL, COALESCE(v.manifest, '')
		FROM materials m LEFT JOIN material_versions v ON v.material_id = m.id AND v.version = m.version
		ORDER BY m.id LIMIT 10000`)
	if err != nil {
		return err
	}
	type oldMat struct {
		id, node, version, at    int64
		name, note, by, manifest string
		archived, superseded     bool
	}
	var list []oldMat
	for rows.Next() {
		var m oldMat
		if err := rows.Scan(&m.id, &m.node, &m.name, &m.note, &m.version, &m.by, &m.at, &m.archived, &m.superseded, &m.manifest); err != nil {
			rows.Close()
			return err
		}
		list = append(list, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	it := Item{Kind: "资料"}
	units, bins := map[string]int{}, map[string]int{}
	var order []string
	for _, m := range list {
		ref, dept := fmt.Sprintf("m%d", m.id), fmt.Sprintf("o%d", m.node)
		switch {
		case m.archived:
			it.Skipped++
			it.Notes = append(it.Notes, ref+" 已归档")
			continue
		case m.superseded:
			it.Skipped++
			it.Notes = append(it.Notes, ref+" 已被新版本取代")
			continue
		case !depts[dept]:
			it.Skipped++
			it.Notes = append(it.Notes, ref+" 所在部门 "+dept+" 没导入")
			continue
		}
		var entries []struct {
			Path string `json:"path"`
			Size int64  `json:"size"`
		}
		if err := json.Unmarshal([]byte(m.manifest), &entries); err != nil {
			return fmt.Errorf("资料 %s 的版本清单读不出：%w", ref, err)
		}
		note := m.note
		if note == "" {
			note = m.name
		}
		src := filepath.Join(oldData, "materials", ref, fmt.Sprintf("v%d", m.version))
		var files []org.MaterialFileInfo
		size, n, bin := 0, 0, 0
		for _, e := range entries {
			if !safeRel(e.Path) {
				return fmt.Errorf("资料 %s 清单里有不安全的路径 %q", ref, e.Path)
			}
			content, err := readSized(filepath.Join(src, filepath.FromSlash(e.Path)), e.Size)
			if err != nil {
				return fmt.Errorf("资料 %s：%w", ref, err)
			}
			u, binary := org.Units(e.Path, content)
			if err := writeNew(filepath.Join(stage, "materials", ref, fmt.Sprintf("r%d", m.version), filepath.FromSlash(e.Path)), content); err != nil {
				return err
			}
			if len(content) > org.MaxMaterialFile<<20 {
				rep.Over = append(rep.Over, fmt.Sprintf("资料 %s 的 %s 有 %d MB，超过单个文件 %d MB", ref, e.Path, org.MB(len(content)), org.MaxMaterialFile))
			}
			files = append(files, org.MaterialFileInfo{Path: e.Path, Size: len(content), Units: u, Binary: binary})
			size += len(content)
			if binary {
				bin += len(content)
			} else {
				n += u
			}
		}
		entry, err := org.PickEntry(files, "")
		if err != nil {
			it.Notes = append(it.Notes, fmt.Sprintf("%s 认不出正文，打开时列出全部 %d 个文件", ref, len(files)))
		}
		entryBinary := false
		for _, f := range files {
			if f.Path == entry {
				entryBinary = f.Binary
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO materials (id, rev, department, kind, title, note, file, size, units, binary, created_by, created_at)
			VALUES (?, ?, ?, 'detail', ?, ?, ?, ?, ?, ?, ?, ?)`, ref, m.version, dept, m.name, note, entry, size, n, entryBinary, m.by, m.at); err != nil {
			return err
		}
		for _, f := range files {
			if _, err := tx.ExecContext(ctx, `INSERT INTO material_files (id, rev, path, size, units, binary) VALUES (?, ?, ?, ?, ?, ?)`,
				ref, m.version, f.Path, f.Size, f.Units, f.Binary); err != nil {
				return err
			}
		}
		if _, ok := units[dept]; !ok {
			order = append(order, dept)
		}
		units[dept] += n
		bins[dept] += bin
		it.Imported++
	}
	for _, d := range order {
		if units[d] > org.MaxMaterial {
			rep.Over = append(rep.Over, fmt.Sprintf("资料文本总量超过每部门 %d 字：%s %d", org.MaxMaterial, d, units[d]))
		}
		if bins[d] > org.MaxMaterialBin<<20 {
			rep.Over = append(rep.Over, fmt.Sprintf("二进制资料超过每部门 %d MB：%s %d MB", org.MaxMaterialBin, d, org.MB(bins[d])))
		}
	}
	add(rep, it)
	return nil
}

// readSized 读一个文件并核对大小（清单与实际不符就停下）。
func readSized(p string, size int64) ([]byte, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	if int64(len(b)) != size {
		return nil, fmt.Errorf("%s 实际 %d 字节，清单写 %d", p, len(b), size)
	}
	return b, nil
}

func writeNew(p string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o600)
}

// importProfiles：旧档案分三层（harness/models/combos），名字带上层名，与旧版文件路径一致（如 harness/claude）。
func importProfiles(ctx context.Context, old *sql.DB, tx *sql.Tx, rep *Report) error {
	rows, err := old.QueryContext(ctx, `SELECT layer, name, source, updated_by, updated_at FROM worker_profiles ORDER BY layer, name LIMIT 10000`)
	if err != nil {
		return err
	}
	defer rows.Close()
	it := Item{Kind: "执行者档案"}
	dropped := map[string][]string{}
	for rows.Next() {
		var layer, name, source, by string
		var at int64
		if err := rows.Scan(&layer, &name, &source, &by, &at); err != nil {
			return err
		}
		full := layer + "/" + name
		source, gone, err := convertProfile(source, gates.Known)
		if err != nil {
			return fmt.Errorf("执行者档案 %s：%w", full, err)
		}
		keys, _, _ := workers.SplitSource(source)
		if err := workers.CheckProfile(full, keys); err != nil {
			return fmt.Errorf("执行者档案 %s 换成新写法后仍不合法：%w", full, err)
		}
		for _, g := range gone {
			dropped[g] = append(dropped[g], full)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO worker_profiles (name, spec, updated_by, updated_at) VALUES (?, ?, ?, ?)`,
			full, source, by, at); err != nil {
			return err
		}
		it.Imported++
	}
	for _, g := range sortedKeys(dropped) {
		it.Notes = append(it.Notes, fmt.Sprintf("去掉新版不认的 %s（%d 份：%s）", g, len(dropped[g]), strings.Join(dropped[g], "、")))
	}
	add(rep, it)
	return rows.Err()
}

// importHosts 搬没移除的机器：名字、种类、仓库、并发上限、机器信息、ssh 隧道目标与私钥路径、隧道远端端口原样；
// 隧道本机端口不搬（旧版是 4310，v2 按自己的服务端口）。令牌与接入码不搬，远程机器要 host edit --join 重新接入。
func importHosts(ctx context.Context, old *sql.DB, tx *sql.Tx, rep *Report) error {
	rows, err := old.QueryContext(ctx, `SELECT id, name, kind, COALESCE(info, ''), COALESCE(repos, '[]'), max_running,
		removed_at IS NOT NULL, last_seen_at, created_at, COALESCE(ssh_target, ''), COALESCE(ssh_key, ''), tunnel_remote_port
		FROM hosts ORDER BY id LIMIT 10000`)
	if err != nil {
		return err
	}
	defer rows.Close()
	it := Item{Kind: "机器"}
	remote := 0
	for rows.Next() {
		var id, at int64
		var name, kind, info, repos, sshTarget, sshKey string
		var maxRunning, seen, tunnelRemote sql.NullInt64
		var removed bool
		if err := rows.Scan(&id, &name, &kind, &info, &repos, &maxRunning, &removed, &seen, &at, &sshTarget, &sshKey, &tunnelRemote); err != nil {
			return err
		}
		ref := fmt.Sprintf("h%d", id)
		if removed {
			it.Skipped++
			it.Notes = append(it.Notes, ref+" 已移除")
			continue
		}
		if err := checkHostJSON(info, repos); err != nil {
			return fmt.Errorf("机器 %s：%w", ref, err)
		}
		if sshTarget == "" || !tunnelRemote.Valid {
			sshKey, tunnelRemote = "", sql.NullInt64{}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO hosts (id, name, kind, repos, max_running, info, last_seen_at, created_at,
			ssh_target, ssh_key, tunnel_remote) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ref, name, kind, repos, nullInt(maxRunning), info,
			nullInt(seen), at, sshTarget, sshKey, nullInt(tunnelRemote)); err != nil {
			return err
		}
		if sshTarget != "" {
			it.Notes = append(it.Notes, fmt.Sprintf("%s 的 ssh 隧道 %s（私钥 %s）带过来了", ref, sshTarget, or(sshKey, "没登记")))
		}
		if kind == "remote" {
			remote++
		}
		it.Imported++
	}
	if remote > 0 {
		it.Notes = append(it.Notes, fmt.Sprintf("%d 台远程机器的令牌没搬，要重新接入：atrium host edit hN --join，照回执在那台上跑", remote))
	}
	add(rep, it)
	return rows.Err()
}

func or(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func nullInt(n sql.NullInt64) any {
	if n.Valid {
		return n.Int64
	}
	return nil
}

// setCounters：各短号计数器接着旧库的最大值往后（任务、选项单、周期任务虽不搬，号也不复用）。
func setCounters(ctx context.Context, old *sql.DB, tx *sql.Tx, rep *Report) error {
	src := map[string]string{"t": "tasks", "o": "org_nodes", "k": "org_points", "a": "org_leaders", "c": "choices",
		"m": "materials", "h": "hosts", "s": "schedules"}
	for _, prefix := range sortedKeys(src) {
		var n sql.NullInt64
		if err := old.QueryRowContext(ctx, `SELECT max(id) FROM `+src[prefix]).Scan(&n); err != nil {
			return fmt.Errorf("读旧库 %s 的最大号：%w", src[prefix], err)
		}
		if !n.Valid || n.Int64 == 0 {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO ids (prefix, last) VALUES (?, ?)
			ON CONFLICT (prefix) DO UPDATE SET last = max(last, excluded.last)`, prefix, n.Int64); err != nil {
			return err
		}
		rep.Counters[prefix] = n.Int64
	}
	return nil
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
