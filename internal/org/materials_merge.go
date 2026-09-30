package org

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// 一次性整理 t502 之前的资料：那时一个目录按文件拆成多条资料（material add 目录、导入的目录资料），
// 库里也没有 material_files。服务启动时：
//  1. 没有 material_files 的版本补一行（旧资料每版一个文件，在 materials/<mN>/r<rev>/<文件名>）；
//  2. 没归档的旧资料里，同部门、同一人、同一说明、2 秒内加的（原本是一个目录）合并成一条：
//     保留正文那条的短号，追加一版带上全部文件（按原标题的相对路径放），其余几条连同文件删掉。
// 整理完库里没有旧资料，以后启动什么都不做；所有库都整理过后删掉本文件。

// flatRow 是一条旧资料的一版。
type flatRow struct {
	id, dept, kind, title, note, file, by string
	rev, size, units                      int
	binary, archived, latest              bool
	at                                    int64
}

// flatGroups 纯判定：旧资料里哪些原本是一个目录（同部门、同一人、同一说明、2 秒内加的最新版，至少两条）。
func flatGroups(rows []flatRow) [][]flatRow {
	var cand []flatRow
	for _, r := range rows {
		if r.latest && !r.archived && r.kind == "detail" {
			cand = append(cand, r)
		}
	}
	key := func(r flatRow) string { return r.dept + "\x00" + r.by + "\x00" + r.note }
	slices.SortStableFunc(cand, func(a, b flatRow) int {
		if c := strings.Compare(key(a), key(b)); c != 0 {
			return c
		}
		return int(a.at - b.at)
	})
	var out [][]flatRow
	for i := 0; i < len(cand); {
		j := i + 1
		for j < len(cand) && key(cand[j]) == key(cand[i]) && cand[j].at-cand[i].at <= 2000 {
			j++
		}
		if j-i > 1 {
			out = append(out, cand[i:j])
		}
		i = j
	}
	return out
}

// mergedSlot 纯判定：一组旧资料合并后的那一版——保留哪条的短号、标题、正文。
// 正文按 PickEntry 认（认不出就没有正文，打开列出全部文件）。旧资料没记目录名：标题取说明的第一段
// （如「t446 magpie 研究报告（……）」取「t446 magpie 研究报告」），说明太长或太短时取共同的第一层目录，再没有取正文（或第一条）的标题。
func mergedSlot(g []flatRow) (keep flatRow, s materialSlot) {
	s = materialSlot{kind: "detail", note: g[0].note}
	for _, r := range g {
		s.files = append(s.files, MaterialFileInfo{Path: r.title, Size: r.size, Units: r.units, Binary: r.binary})
		if r.binary {
			s.bin += r.size
		} else {
			s.units += r.units
		}
	}
	slices.SortFunc(s.files, func(a, b MaterialFileInfo) int { return strings.Compare(a.Path, b.Path) })
	s.entry, _ = PickEntry(s.files, "")
	keep = g[0]
	for _, r := range g {
		num := func(id string) int { n, _ := strconv.Atoi(id[1:]); return n }
		if (s.entry != "" && r.title == s.entry) || (s.entry == "" && num(r.id) < num(keep.id)) {
			keep = r
		}
	}
	s.id, s.rev, s.title = keep.id, keep.rev+1, keep.title
	if top, _, ok := strings.Cut(g[0].title, "/"); ok {
		shared := true
		for _, r := range g {
			shared = shared && strings.HasPrefix(r.title, top+"/")
		}
		if shared {
			s.title = top
		}
	}
	if head := noteHead(s.note); head != "" {
		s.title = head
	}
	return keep, s
}

// noteHead 纯函数：说明的第一段（到第一个括号、冒号、分号、逗号、句号为止），4～40 字才算，否则返回空。
func noteHead(note string) string {
	head := note
	if i := strings.IndexFunc(note, func(r rune) bool { return strings.ContainsRune("（(：:；;，,。\n", r) }); i >= 0 {
		head = note[:i]
	}
	head = strings.TrimSpace(head)
	if n := utf8.RuneCountInString(head); n < 4 || n > 40 {
		return ""
	}
	return head
}

// mergeFlatMaterials 做上面的整理，返回合并了几组。
func mergeFlatMaterials(ctx context.Context, db *store.DB, data string) (int, error) {
	var removed []string
	groups := 0
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT id, rev, department, kind, title, note, file, size, units, binary,
			archived_at IS NOT NULL, created_by, created_at, rev = (SELECT max(rev) FROM materials WHERE id = m.id)
			FROM materials m WHERE NOT EXISTS (SELECT 1 FROM material_files f WHERE f.id = m.id AND f.rev = m.rev)
			ORDER BY id, rev LIMIT ?`, ReadCap*10)
		if err != nil {
			return err
		}
		var old []flatRow
		for rows.Next() {
			var r flatRow
			if err := rows.Scan(&r.id, &r.rev, &r.dept, &r.kind, &r.title, &r.note, &r.file, &r.size, &r.units, &r.binary,
				&r.archived, &r.by, &r.at, &r.latest); err != nil {
				rows.Close()
				return err
			}
			old = append(old, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, r := range old {
			if _, err := tx.ExecContext(ctx, `INSERT INTO material_files (id, rev, path, size, units, binary) VALUES (?, ?, ?, ?, ?, ?)`,
				r.id, r.rev, r.file, r.size, r.units, r.binary); err != nil {
				return err
			}
		}
		for _, g := range flatGroups(old) {
			keep, s := mergedSlot(g)
			var at int64
			for _, r := range g {
				raw, err := os.ReadFile(materialFile(data, r.id, r.rev, r.file))
				if err != nil {
					return err
				}
				if err := writeFile(materialFile(data, s.id, s.rev, r.title), raw, 0o600); err != nil {
					return err
				}
				at = max(at, r.at)
			}
			if err := insertMaterialRev(ctx, tx, s, keep.dept, keep.by, at); err != nil {
				return err
			}
			for _, r := range g {
				if r.id == keep.id {
					continue
				}
				for _, t := range []string{"material_files", "materials"} {
					if _, err := tx.ExecContext(ctx, `DELETE FROM `+t+` WHERE id = ?`, r.id); err != nil {
						return err
					}
				}
				removed = append(removed, r.id)
			}
			groups++
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	for _, id := range removed {
		if err := os.RemoveAll(filepath.Join(data, "materials", id)); err != nil {
			return groups, err
		}
	}
	return groups, nil
}
