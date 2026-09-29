package org

// 删除部门与负责人（实体一生的最后一步）：没有引用时直接删，有引用时拒绝并逐类列出。
// 判定是纯函数 CheckDelete；IO 只数引用（refsOf）。自己的附属随之删掉：部门的要点、仓库清单、暂停；负责人的备忘。

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
func CheckDelete(what string, refs []Refs) error {
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

func deptRefs(id string) []refQuery {
	return []refQuery{
		{"下属部门", "departments", "id", "parent = ?", "先挪走或删掉（atrium org edit <oN> --parent <别的部门>）"},
		{"任务", "tasks", "id", "department = ?", "改归属（atrium task set <tN> --org <别的部门>）"},
		{"周期任务", "schedules", "id", "department = ?", "删掉或在别的部门重建（atrium schedule rm <sN>）"},
		{"待拍板的选项单", "choices", "id", "department = ? AND status = 'open'", "先拍板或放弃（atrium choice pick <cN> --none）"},
		{"选项单", "choices", "id", "department = ? AND status != 'open'", "已拍板的选项单是记录，没法挪：部门留着"},
		{"资料", "materials", "id", "department = ?", "资料（含归档的）没法挪：部门留着，或用 atrium material ls --node " + id + " 看"},
		{"凭据", "secrets", "name", "department = ?", "删掉（atrium secret set " + id + " <名称> --rm）或在别的部门重设"},
		{"没确认的事件", "events", "id", "department = ? AND acked_at IS NULL", "处理完确认（atrium events ack <编号>）"},
	}
}

// DeleteDept 删一个部门：有引用时拒绝并列出；没有时连同它的要点、仓库清单与暂停一起删，已确认事件上的部门标记清掉。返回删掉前的部门。
func DeleteDept(ctx context.Context, db *store.DB, id string) (Dept, error) {
	var d Dept
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		var err error
		if d, err = Get(ctx, tx, id); err != nil {
			return err
		}
		refs, err := refsOf(ctx, tx, id, deptRefs(id))
		if err != nil {
			return err
		}
		if err := CheckDelete("部门 "+id+" "+d.Name, refs); err != nil {
			return err
		}
		for _, s := range []string{
			`DELETE FROM points WHERE department = ?`,
			`DELETE FROM department_repos WHERE department = ?`,
			`DELETE FROM acceptors WHERE department = ?`,
			`DELETE FROM pauses WHERE scope = ?`,
			`UPDATE events SET department = NULL WHERE department = ?`, // 只剩已确认的（没确认的上面挡了）
			`DELETE FROM departments WHERE id = ?`,
		} {
			if _, err := tx.ExecContext(ctx, s, id); err != nil {
				return err
			}
		}
		return nil
	})
	return d, err
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
