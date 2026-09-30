package org

// 删除部门与负责人（实体一生的最后一步）：没有引用时直接删，有引用时拒绝并逐类列出；
// 部门可以带 --into 把记录并入另一个部门后删掉。判定是纯函数 CheckDelete、CheckInto；IO 只数引用（refsOf）与挪动。
// 自己的附属随之删掉：部门的要点、仓库清单、验收人、暂停；负责人的备忘。

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Refs 是挡着删除的一类引用：是什么、共几条、前几个编号、怎么腾开。
type Refs struct {
	What string
	N    int
	IDs  []string
	Fix  string
}

const refSample = 5 // 每类列前几个编号

// CheckDelete 纯判定：有引用就拒绝（409），逐类列出几条、前几个编号与怎么腾开；都没有返回 nil。
func CheckDelete(what string, refs []Refs) *api.Error {
	var lines []string
	for _, r := range refs {
		if r.N == 0 {
			continue
		}
		ids := strings.Join(r.IDs, "、")
		if r.N > len(r.IDs) {
			ids += "…"
		}
		lines = append(lines, fmt.Sprintf("  %s %d（%s）：%s", r.What, r.N, ids, r.Fix))
	}
	if len(lines) == 0 {
		return nil
	}
	return api.Conflict("%s 还有引用，不能删：\n%s", what, strings.Join(lines, "\n"))
}

// refQuery 是一类引用的查法：表、编号列、条件（一个参数）。
type refQuery struct{ what, table, col, where, fix string }

func refsOf(ctx context.Context, q store.Querier, id string, list []refQuery) ([]Refs, error) {
	var out []Refs
	for _, rq := range list {
		r := Refs{What: rq.what, Fix: rq.fix}
		from := ` FROM ` + rq.table + ` WHERE ` + rq.where
		if err := q.QueryRowContext(ctx, `SELECT count(DISTINCT `+rq.col+`)`+from, id).Scan(&r.N); err != nil {
			return nil, err
		}
		if r.N > 0 {
			rows, err := q.QueryContext(ctx, `SELECT DISTINCT `+rq.col+from+` ORDER BY length(`+rq.col+`), `+rq.col+` LIMIT ?`, id, refSample)
			if err != nil {
				return nil, err
			}
			for rows.Next() {
				var v string
				if err := rows.Scan(&v); err != nil {
					rows.Close()
					return nil, err
				}
				r.IDs = append(r.IDs, v)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}
		}
		out = append(out, r)
	}
	return out, nil
}

// deptBlockers 是并入也挡着删除、要人先处理的引用：还在跑的任务与没拍板的选项单挪了会乱，
// 凭据挪过去会扩大可见范围，没确认的事件要有人看过。
func deptBlockers(id string) []refQuery {
	return []refQuery{
		{"进行中的任务", "tasks", "id", "department = ? AND status IN ('queued', 'running')", "等它结束或先停下（atrium task stop <tN>）"},
		{"待拍板的选项单", "choices", "id", "department = ? AND status = 'open'", "先拍板或放弃（atrium choice pick <cN> --none）"},
		{"凭据", "secrets", "name", "department = ?", "删掉（atrium secret set " + id + " <名称> --rm）或在别的部门重设"},
		{"没确认的事件", "events", "id", "department = ? AND acked_at IS NULL", "处理完确认（atrium events ack <编号>）"},
	}
}

// movable 是并入时挪到目标部门的一类引用；move 是挪的语句，参数依次是目标、本部门。
type movable struct {
	refQuery
	move string
}

// deptMovables 列全存了部门编号、并入时要挪的表（挡着的见 deptBlockers，随部门删掉的见 DeleteDept）。
// 数的时候不含挡着的那几类（挡着时不会挪）；资料连同归档的一起挪，本部门的总览挪过去改作细节（一个部门只有一份总览）。
func deptMovables() []movable {
	const fix = "加 --into 并入时一并挪过去"
	return []movable{
		{refQuery{"下属部门", "departments", "id", "parent = ?", fix}, `UPDATE departments SET parent = ? WHERE parent = ?`},
		{refQuery{"任务", "tasks", "id", "department = ? AND status NOT IN ('queued', 'running')", fix}, `UPDATE tasks SET department = ? WHERE department = ?`},
		{refQuery{"周期任务", "schedules", "id", "department = ?", fix}, `UPDATE schedules SET department = ? WHERE department = ?`},
		{refQuery{"已拍板的选项单", "choices", "id", "department = ? AND status != 'open'", fix}, `UPDATE choices SET department = ? WHERE department = ?`},
		{refQuery{"选项单里归它的选项", "choice_option_orgs", "choice", "department = ?", fix},
			`UPDATE choice_option_orgs SET department = ? WHERE department = ?`},
		{refQuery{"资料", "materials", "id", "department = ?", fix}, `UPDATE materials SET department = ?, kind = 'detail' WHERE department = ?`},
	}
}

// CheckInto 纯判定：把部门 id 并入 into 行不行——into 存在、不是它自己或下属、它的下属挪过去后树不超过 MaxDepth。
func CheckInto(parents map[string]string, id, into string) error {
	if _, ok := parents[into]; !ok {
		return api.NotFound("--into: 部门 %s 不存在", into)
	}
	for cur := into; cur != ""; cur = parents[cur] {
		if cur == id {
			return api.Usage("--into: %s 是 %s 自己或它的下属，不能并进去", into, id)
		}
	}
	if d := Depth(parents, into) + height(parents, id) - 1; d > MaxDepth {
		return api.Limit("atrium org tree", "部门树最多 %d 层：%s 的下属挪到 %s 下会到第 %d 层。并入更浅的部门", MaxDepth, id, into, d)
	}
	return nil
}

// intoHint 纯函数：不写 --into 被挡时补的一行与下一步——有上级就给并入上级的整条命令，顶层部门要自己指定。
func intoHint(id, parent string) (line, next string) {
	if parent == "" {
		return id + " 是顶层部门，没有上级：并入要写明 --into <oM>", "atrium org edit " + id + " --delete --into <oM>"
	}
	return "能挪的几类可以整体并入上级 " + parent + "（--into " + parent + "）", "atrium org edit " + id + " --delete --into " + parent
}

// Removed 是删部门的回执：删掉前的部门；并入时带并入到哪、各类挪了几条（0 条的不列）。
type Removed struct {
	Dept
	Into  string  `json:"into,omitempty"`
	Moved []Moved `json:"moved,omitempty"`
}

type Moved struct {
	What string `json:"what"`
	N    int    `json:"n"`
}

// removedLine 是删部门的回执一行：并入了几条什么。
func removedLine(r Removed) string {
	s := fmt.Sprintf("已删部门 %s %s（连同要点、仓库清单、验收人与暂停）", r.ID, r.Name)
	if r.Into == "" {
		return s
	}
	var parts []string
	for _, m := range r.Moved {
		parts = append(parts, fmt.Sprintf("%s %d", m.What, m.N))
	}
	if len(parts) == 0 {
		return s + "；没有要并入 " + r.Into + " 的记录"
	}
	return s + "；并入 " + r.Into + "：" + strings.Join(parts, "、")
}

// DeleteDept 删一个部门（p 只能带 Delete 与 Into）。不带 Into：有任何引用就拒绝并列出。
// 带 Into：进行中的任务、待拍板的选项单、凭据、没确认的事件仍然挡着；其余引用在同一个事务里挪到 Into 再删。
// 部门自己的要点、仓库清单、验收人、暂停、上限提醒随之删掉，已确认事件上的部门标记清掉。
func DeleteDept(ctx context.Context, db *store.DB, id string, p DeptPatch) (Removed, error) {
	if p.edits() {
		return Removed{}, api.Usage("--delete: 不和别的字段一起给")
	}
	var r Removed
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		var err error
		if r.Dept, err = Get(ctx, tx, id); err != nil {
			return err
		}
		blocks, err := refsOf(ctx, tx, id, deptBlockers(id))
		if err != nil {
			return err
		}
		movables := deptMovables()
		qs := make([]refQuery, len(movables))
		for i, m := range movables {
			qs[i] = m.refQuery
		}
		moves, err := refsOf(ctx, tx, id, qs)
		if err != nil {
			return err
		}
		what := "部门 " + id + " " + r.Name
		if p.Into == nil {
			if err := CheckDelete(what, append(blocks, moves...)); err != nil {
				line, next := intoHint(id, r.Parent)
				err.Message += "\n" + line
				return err.WithNext(next)
			}
		} else {
			ps, err := parents(ctx, tx)
			if err != nil {
				return err
			}
			if err := CheckInto(ps, id, *p.Into); err != nil {
				return err
			}
			if err := CheckDelete(what, blocks); err != nil {
				return err
			}
			r.Into = *p.Into
			for i, m := range moves {
				if m.N == 0 {
					continue
				}
				if _, err := tx.ExecContext(ctx, movables[i].move, r.Into, id); err != nil {
					return err
				}
				r.Moved = append(r.Moved, Moved{m.What, m.N})
			}
		}
		for _, s := range []string{
			`DELETE FROM points WHERE department = ?`,
			`DELETE FROM department_repos WHERE department = ?`,
			`DELETE FROM acceptors WHERE department = ?`,
			`DELETE FROM pauses WHERE scope = ?`,
			`DELETE FROM limit_notices WHERE scope = ?`,
			`UPDATE events SET department = NULL WHERE department = ?`, // 只剩已确认的（没确认的上面挡了）
			`DELETE FROM departments WHERE id = ?`,
		} {
			if _, err := tx.ExecContext(ctx, s, id); err != nil {
				return err
			}
		}
		return nil
	})
	return r, err
}

// DeleteLeader 删一位负责人：还负责部门或有没确认的事件时拒绝；没有时连同备忘一起删。返回删掉前的身份。
func DeleteLeader(ctx context.Context, db *store.DB, id string) (Identity, error) {
	var i Identity
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		var err error
		if i, err = GetIdentity(ctx, tx, id); err != nil {
			return err
		}
		if i.Kind != "leader" {
			return api.Usage("%s 不是负责人（aN）", id)
		}
		refs, err := refsOf(ctx, tx, id, []refQuery{
			{"负责的部门", "departments", "id", "leader = ?", "换人或清掉（atrium org edit <oN> --leader <aN|->）"},
			{"没确认的事件", "events", "id", "target = ? AND acked_at IS NULL",
				"取走处理完再确认（atrium events wait --as " + id + "，atrium events ack <编号>）"},
		})
		if err != nil {
			return err
		}
		if err := CheckDelete("负责人 "+id+" "+i.Name, refs); err != nil {
			return err
		}
		for _, s := range []string{`DELETE FROM memos WHERE identity = ?`, `DELETE FROM identities WHERE id = ?`} {
			if _, err := tx.ExecContext(ctx, s, id); err != nil {
				return err
			}
		}
		return nil
	})
	return i, err
}
