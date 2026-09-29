package org

import (
	"context"
	"database/sql"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 验收人：部门级设置，沿树继承——交付过了关卡（和审阅）之后，谁判它能不能落地。
const (
	AcceptAuto   = "auto"   // 运行时：过了关卡、审阅直接落地（缺省）
	AcceptLeader = "leader" // 部门往上最近的负责人
	AcceptUser   = "user"   // 用户（经秘书投给你）
)

// ResolveAcceptor 纯判定：从 dept 往上找最近设了验收人的部门；都没设为 auto。from 是设它的部门（没设为空）。
func ResolveAcceptor(parents, set map[string]string, dept string) (who, from string) {
	for cur, n := dept, 0; cur != "" && n <= MaxDepth; cur, n = parents[cur], n+1 {
		if w := set[cur]; w != "" {
			return w, cur
		}
	}
	return AcceptAuto, ""
}

// Acceptor 查部门的验收人（沿树继承）；没给部门为 auto。
func Acceptor(ctx context.Context, q store.Querier, dept string) (who, from string, err error) {
	if dept == "" {
		return AcceptAuto, "", nil
	}
	ps, err := parents(ctx, q)
	if err != nil {
		return "", "", err
	}
	rows, err := q.QueryContext(ctx, `SELECT department, who FROM acceptors LIMIT ?`, ReadCap+1)
	if err != nil {
		return "", "", err
	}
	defer rows.Close()
	set := map[string]string{}
	for rows.Next() {
		var d, w string
		if err := rows.Scan(&d, &w); err != nil {
			return "", "", err
		}
		set[d] = w
	}
	if err := rows.Err(); err != nil {
		return "", "", err
	}
	if err := capErr("设了验收人的部门", len(set)); err != nil {
		return "", "", err
	}
	who, from = ResolveAcceptor(ps, set, dept)
	return who, from, nil
}

// MayAccept 纯判定：actor 能不能替验收人 who 判。用户与秘书都行；负责人只在验收人不是用户时
// （管辖由负责人权限另判）。
func MayAccept(actor, who string) bool {
	if actor == "u1" || actor == Secretary {
		return true
	}
	return api.IsRef(actor, "a") && who != AcceptUser
}

// setAcceptor 设部门的验收人；"-" 清掉（改回继承上级）。
func setAcceptor(ctx context.Context, tx *sql.Tx, dept, who string) error {
	switch who {
	case "-":
		_, err := tx.ExecContext(ctx, `DELETE FROM acceptors WHERE department = ?`, dept)
		return err
	case AcceptAuto, AcceptLeader, AcceptUser:
		_, err := tx.ExecContext(ctx, `INSERT INTO acceptors (department, who) VALUES (?, ?)
			ON CONFLICT (department) DO UPDATE SET who = excluded.who`, dept, who)
		return err
	}
	return api.Usage("--accept: 应为 auto（运行时）、leader（负责人）、user（你），或 - 改回继承上级；收到 %q", who)
}
