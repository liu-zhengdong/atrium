package org

// 身份：用户 u1、秘书 secretary、负责人 aN（名字、执行者组合）。备忘在 memos.go。
// 投递对象（事件投给谁）与负责人的管辖范围也在这里：判定是纯函数（Nearest、Scope），IO 只取部门与负责人两张映射。

import (
	"context"
	"database/sql"
	"slices"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Secretary 是秘书的固定身份；部门往上都没有负责人时事件投给它。
const Secretary = "secretary"

type Identity struct {
	ID        string   `json:"id"`
	Kind      string   `json:"kind"`
	Name      string   `json:"name"`
	Workers   []string `json:"workers"` // 执行者组合：唤醒时按顺序轮换的档案名
	Depts     []string `json:"depts"`   // 负责的部门
	CreatedAt int64    `json:"created_at"`
}

// NewLeader 是 leader add 的输入。
type NewLeader struct {
	Name    string   `json:"name"`
	Workers []string `json:"workers"`
}

// LeaderPatch 是 leader edit 的输入；nil 表示不改。
type LeaderPatch struct {
	Name    *string   `json:"name,omitempty"`
	Workers *[]string `json:"workers,omitempty"`
}

func checkWorkers(list []string) error {
	if len(list) == 0 {
		return api.Usage("--workers: 至少给一个执行者档案（唤醒负责人时用它起进程）")
	}
	if len(list) > MaxLeaderWorkers {
		return api.Usage("--workers: 最多 %d 个", MaxLeaderWorkers)
	}
	for i, w := range list {
		if err := checkText("workers", w, maxName, true); err != nil {
			return err
		}
		if strings.ContainsAny(w, ", \t\n") {
			return api.Usage("--workers: 档案名不能含逗号或空白，收到 %q", w)
		}
		if slices.Contains(list[:i], w) {
			return api.Usage("--workers: %s 重复了", w)
		}
	}
	return nil
}

func AddLeader(ctx context.Context, db *store.DB, in NewLeader) (Identity, error) {
	if err := checkText("name", in.Name, maxName, true); err != nil {
		return Identity{}, err
	}
	if err := checkWorkers(in.Workers); err != nil {
		return Identity{}, err
	}
	var id string
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM identities WHERE kind = 'leader'`).Scan(&n); err != nil {
			return err
		}
		if n >= MaxLeaders {
			return api.Limit("atrium leader ls", "负责人已有 %d 位（上限）：先把闲着的并掉", n)
		}
		var err error
		if id, err = store.NextID(ctx, tx, "a"); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO identities (id, kind, name, workers, created_at) VALUES (?, 'leader', ?, ?, ?)`,
			id, strings.TrimSpace(in.Name), strings.Join(in.Workers, ","), store.Now())
		return err
	})
	if err != nil {
		return Identity{}, err
	}
	return GetIdentity(ctx, db, id)
}

func EditLeader(ctx context.Context, db *store.DB, id string, p LeaderPatch) (Identity, error) {
	if p.Name == nil && p.Workers == nil {
		return Identity{}, api.Usage("没有要改的字段").WithNext("atrium leader edit --help")
	}
	if p.Name != nil {
		if err := checkText("name", *p.Name, maxName, true); err != nil {
			return Identity{}, err
		}
	}
	if p.Workers != nil {
		if err := checkWorkers(*p.Workers); err != nil {
			return Identity{}, err
		}
	}
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		cur, err := GetIdentity(ctx, tx, id)
		if err != nil {
			return err
		}
		if cur.Kind != "leader" {
			return api.Usage("%s 不是负责人（aN）", id)
		}
		if p.Name != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE identities SET name = ? WHERE id = ?`, strings.TrimSpace(*p.Name), id); err != nil {
				return err
			}
		}
		if p.Workers != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE identities SET workers = ? WHERE id = ?`, strings.Join(*p.Workers, ","), id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Identity{}, err
	}
	return GetIdentity(ctx, db, id)
}

func scanIdentity(scan func(...any) error) (Identity, error) {
	var i Identity
	var workers string
	if err := scan(&i.ID, &i.Kind, &i.Name, &workers, &i.CreatedAt); err != nil {
		return Identity{}, err
	}
	i.Workers = []string{}
	if workers != "" {
		i.Workers = strings.Split(workers, ",")
	}
	return i, nil
}

// GetIdentity 读一个身份（含负责的部门）。
func GetIdentity(ctx context.Context, q store.Querier, id string) (Identity, error) {
	i, err := scanIdentity(q.QueryRowContext(ctx, `SELECT id, kind, name, workers, created_at FROM identities WHERE id = ?`, id).Scan)
	if store.IsNotFound(err) {
		return Identity{}, api.NotFound("身份 %s 不存在", id).WithNext("atrium leader ls")
	}
	if err != nil {
		return Identity{}, err
	}
	leaders, err := LeaderMap(ctx, q)
	if err != nil {
		return Identity{}, err
	}
	i.Depts = Led(leaders, id)
	return i, nil
}

// Leaders 列全部负责人（按建立先后）。
func Leaders(ctx context.Context, q store.Querier) ([]Identity, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, kind, name, workers, created_at FROM identities
		WHERE kind = 'leader' ORDER BY created_at, id LIMIT ?`, MaxLeaders)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Identity{}
	for rows.Next() {
		i, err := scanIdentity(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	leaders, err := LeaderMap(ctx, q)
	if err != nil {
		return nil, err
	}
	for k := range out {
		out[k].Depts = Led(leaders, out[k].ID)
	}
	return out, nil
}

// Parents 读全部部门的上级关系（部门 → 上级，顶层为空串）。
func Parents(ctx context.Context, q store.Querier) (map[string]string, error) { return parents(ctx, q) }

// LeaderMap 读「部门 → 负责人」（只含有负责人的部门）。
func LeaderMap(ctx context.Context, q store.Querier) (map[string]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, leader FROM departments WHERE leader IS NOT NULL LIMIT ?`, MaxDepts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := map[string]string{}
	for rows.Next() {
		var d, l string
		if err := rows.Scan(&d, &l); err != nil {
			return nil, err
		}
		m[d] = l
	}
	return m, rows.Err()
}

// Nearest 纯判定：从 dept 往上找最近的负责人，跳过 skip（上交时跳过自己）；都没有返回秘书。
func Nearest(parents, leaders map[string]string, dept, skip string) string {
	for cur, n := dept, 0; cur != "" && n <= MaxDepth; cur, n = parents[cur], n+1 {
		if l := leaders[cur]; l != "" && l != skip {
			return l
		}
	}
	return Secretary
}

// Recipient 是事件的投递对象：部门往上最近的负责人，没有（或没给部门）投秘书。
// events 包在 Target 留空时调它。
func Recipient(ctx context.Context, q store.Querier, dept string) (string, error) {
	if dept == "" {
		return Secretary, nil
	}
	ps, err := parents(ctx, q)
	if err != nil {
		return "", err
	}
	leaders, err := LeaderMap(ctx, q)
	if err != nil {
		return "", err
	}
	return Nearest(ps, leaders, dept, ""), nil
}

// Led 纯函数：who 直接负责的部门（按短号数字排序）。
func Led(leaders map[string]string, who string) []string {
	out := []string{}
	for d, l := range leaders {
		if l == who {
			out = append(out, d)
		}
	}
	slices.SortFunc(out, compareRef)
	return out
}

// Scope 纯判定：who 管得着的部门——自己负责的部门及其全部下属。
func Scope(parents, leaders map[string]string, who string) map[string]bool {
	led := map[string]bool{}
	for _, d := range Led(leaders, who) {
		led[d] = true
	}
	scope := map[string]bool{}
	for d := range parents {
		for cur, n := d, 0; cur != "" && n <= MaxDepth; cur, n = parents[cur], n+1 {
			if led[cur] {
				scope[d] = true
				break
			}
		}
	}
	return scope
}

// compareRef 按短号数字比较（o2 < o10）。
func compareRef(a, b string) int {
	if len(a) != len(b) {
		return len(a) - len(b)
	}
	return strings.Compare(a, b)
}
