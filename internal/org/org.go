// Package org 是组织：部门（树、人话介绍、负责人、仓库清单）与要点（规矩，沿树继承）。
// 第一波做部门与要点；身份、备忘、技能、资料、选项单、决定、周期任务由第二波在本目录另建文件补上。
// 判定在 model.go（纯函数）；本文件是落库。
package org

import (
	"context"
	"database/sql"
	"slices"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

type Dept struct {
	ID        string   `json:"id"`
	Parent    string   `json:"parent,omitempty"`
	Name      string   `json:"name"`
	What      string   `json:"what"`
	Uses      string   `json:"uses"`
	Now       string   `json:"now"`
	Next      string   `json:"next"`
	Leader    string   `json:"leader,omitempty"`
	Repos     []string `json:"repos"`
	CreatedAt int64    `json:"created_at"`
	UpdatedAt int64    `json:"updated_at"`
}

type Point struct {
	ID        string `json:"id"`
	Org       string `json:"org"`
	Pos       int    `json:"pos"`
	Text      string `json:"text"`
	Why       string `json:"why"`
	By        string `json:"by"`
	Check     string `json:"check,omitempty"`
	UpdatedBy string `json:"updated_by"`
	UpdatedAt int64  `json:"updated_at"`
}

// Get 读一个部门（含仓库清单）。
func Get(ctx context.Context, q store.Querier, id string) (Dept, error) {
	var d Dept
	var parent, leader sql.NullString
	err := q.QueryRowContext(ctx, `SELECT id, parent, name, what, uses, now, next, leader, created_at, updated_at
		FROM departments WHERE id = ?`, id).
		Scan(&d.ID, &parent, &d.Name, &d.What, &d.Uses, &d.Now, &d.Next, &leader, &d.CreatedAt, &d.UpdatedAt)
	if store.IsNotFound(err) {
		return Dept{}, api.NotFound("部门 %s 不存在", id).WithNext("atrium org tree")
	}
	if err != nil {
		return Dept{}, err
	}
	d.Parent, d.Leader = parent.String, leader.String
	d.Repos, err = repos(ctx, q, id)
	return d, err
}

func repos(ctx context.Context, q store.Querier, id string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT repo FROM department_repos WHERE department = ? ORDER BY repo LIMIT ?`, id, MaxRepos)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var r string
		if err := rows.Scan(&r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// parents 读全部部门的上级关系。
func parents(ctx context.Context, q store.Querier) (map[string]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, COALESCE(parent, '') FROM departments LIMIT ?`, MaxDepts+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := map[string]string{}
	for rows.Next() {
		var id, p string
		if err := rows.Scan(&id, &p); err != nil {
			return nil, err
		}
		m[id] = p
	}
	return m, rows.Err()
}

// Ancestors 返回从顶层到 id 的部门链（含 id 自己）。暂停判定与要点链都用它。
func Ancestors(ctx context.Context, q store.Querier, id string) ([]string, error) {
	ps, err := parents(ctx, q)
	if err != nil {
		return nil, err
	}
	if _, ok := ps[id]; !ok {
		return nil, api.NotFound("部门 %s 不存在", id)
	}
	var chain []string
	for cur := id; cur != "" && len(chain) <= MaxDepth; cur = ps[cur] {
		chain = append(chain, cur)
	}
	slices.Reverse(chain)
	return chain, nil
}

// Chain 是部门的要点链：从顶层到本部门，各部门按 pos 排。派活时每条附一行（ChainLine）。
func Chain(ctx context.Context, q store.Querier, id string) ([]Point, error) {
	chain, err := Ancestors(ctx, q, id)
	if err != nil {
		return nil, err
	}
	out := []Point{}
	for _, d := range chain {
		ps, err := Points(ctx, q, d)
		if err != nil {
			return nil, err
		}
		out = append(out, ps...)
	}
	return out, nil
}

// Points 取一个部门自己的要点（按 pos）。
func Points(ctx context.Context, q store.Querier, dept string) ([]Point, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, department, pos, text, why, decided_by, check_ref, updated_by, updated_at
		FROM points WHERE department = ? ORDER BY pos LIMIT ?`, dept, MaxPoints)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Point{}
	for rows.Next() {
		var p Point
		if err := rows.Scan(&p.ID, &p.Org, &p.Pos, &p.Text, &p.Why, &p.By, &p.Check, &p.UpdatedBy, &p.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// NewDept 是 org add 的输入。
type NewDept struct {
	Name   string   `json:"name"`
	Parent string   `json:"parent"`
	What   string   `json:"what"`
	Uses   string   `json:"uses"`
	Now    string   `json:"now"`
	Next   string   `json:"next"`
	Leader string   `json:"leader"`
	Repos  []string `json:"repos"`
}

func checkIntro(what, uses, now, next *string) error {
	for _, f := range []struct {
		name string
		v    *string
	}{{"what", what}, {"uses", uses}, {"now", now}, {"next", next}} {
		if f.v != nil {
			if err := checkText(f.name, *f.v, maxIntro, false); err != nil {
				return err
			}
		}
	}
	return nil
}

func checkLeader(ctx context.Context, q store.Querier, id string) error {
	var kind string
	err := q.QueryRowContext(ctx, `SELECT kind FROM identities WHERE id = ?`, id).Scan(&kind)
	if store.IsNotFound(err) {
		return api.NotFound("--leader: %s 不存在", id)
	}
	if err != nil {
		return err
	}
	if kind != "leader" {
		return api.Usage("--leader: %s 不是负责人（aN）", id)
	}
	return nil
}

func Add(ctx context.Context, db *store.DB, in NewDept) (Dept, error) {
	if err := checkText("name", in.Name, maxName, true); err != nil {
		return Dept{}, err
	}
	if err := checkIntro(&in.What, &in.Uses, &in.Now, &in.Next); err != nil {
		return Dept{}, err
	}
	if len(in.Repos) > MaxRepos {
		return Dept{}, api.Usage("--repo: 每个部门最多 %d 个仓库；多了就拆子部门", MaxRepos)
	}
	var id string
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		ps, err := parents(ctx, tx)
		if err != nil {
			return err
		}
		if len(ps) >= MaxDepts {
			return api.Limit("atrium org tree", "部门已有 %d 个（上限）：先合并", MaxDepts)
		}
		if in.Parent != "" {
			if _, ok := ps[in.Parent]; !ok {
				return api.NotFound("--parent: 部门 %s 不存在", in.Parent).WithNext("atrium org tree")
			}
		}
		if err := CheckPlace(ps, "", in.Parent); err != nil {
			return err
		}
		if in.Leader != "" {
			if err := checkLeader(ctx, tx, in.Leader); err != nil {
				return err
			}
		}
		if id, err = store.NextID(ctx, tx, "o"); err != nil {
			return err
		}
		now := store.Now()
		if _, err := tx.ExecContext(ctx, `INSERT INTO departments (id, parent, name, what, uses, now, next, leader,
			created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, store.Null(in.Parent),
			strings.TrimSpace(in.Name), in.What, in.Uses, in.Now, in.Next, store.Null(in.Leader), now, now); err != nil {
			return err
		}
		return addRepos(ctx, tx, id, in.Repos)
	})
	if err != nil {
		return Dept{}, err
	}
	return Get(ctx, db, id)
}

func addRepos(ctx context.Context, tx *sql.Tx, id string, list []string) error {
	for _, r := range list {
		if err := checkText("repo", r, 200, true); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO department_repos (department, repo) VALUES (?, ?)`, id, r); err != nil {
			return err
		}
	}
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM department_repos WHERE department = ?`, id).Scan(&n); err != nil {
		return err
	}
	if n > MaxRepos {
		return api.Limit("atrium org show "+id, "部门 %s 的仓库会有 %d 个（上限 %d）：拆子部门，或先去掉不用的（--repo-rm）", id, n, MaxRepos)
	}
	return nil
}

// DeptPatch 是 org edit 的输入；nil 表示不改。Leader 给 "-" 表示清掉；Parent 给 "-" 表示挪到顶层。
type DeptPatch struct {
	Name     *string  `json:"name,omitempty"`
	Parent   *string  `json:"parent,omitempty"`
	What     *string  `json:"what,omitempty"`
	Uses     *string  `json:"uses,omitempty"`
	Now      *string  `json:"now,omitempty"`
	Next     *string  `json:"next,omitempty"`
	Leader   *string  `json:"leader,omitempty"`
	RepoAdd  []string `json:"repo_add,omitempty"`
	RepoDrop []string `json:"repo_rm,omitempty"`
}

func Edit(ctx context.Context, db *store.DB, id string, p DeptPatch) (Dept, error) {
	if p.Name == nil && p.Parent == nil && p.What == nil && p.Uses == nil && p.Now == nil && p.Next == nil &&
		p.Leader == nil && len(p.RepoAdd) == 0 && len(p.RepoDrop) == 0 {
		return Dept{}, api.Usage("没有要改的字段").WithNext("atrium org edit --help")
	}
	if p.Name != nil {
		if err := checkText("name", *p.Name, maxName, true); err != nil {
			return Dept{}, err
		}
	}
	if err := checkIntro(p.What, p.Uses, p.Now, p.Next); err != nil {
		return Dept{}, err
	}
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := Get(ctx, tx, id); err != nil {
			return err
		}
		sets, args := []string{}, []any{}
		add := func(col string, v any) { sets, args = append(sets, col+" = ?"), append(args, v) }
		if p.Parent != nil {
			parent := *p.Parent
			if parent == "-" {
				parent = ""
			}
			ps, err := parents(ctx, tx)
			if err != nil {
				return err
			}
			if _, ok := ps[parent]; parent != "" && !ok {
				return api.NotFound("--parent: 部门 %s 不存在", parent)
			}
			if err := CheckPlace(ps, id, parent); err != nil {
				return err
			}
			add("parent", store.Null(parent))
		}
		if p.Leader != nil {
			leader := *p.Leader
			if leader == "-" {
				leader = ""
			} else if err := checkLeader(ctx, tx, leader); err != nil {
				return err
			}
			add("leader", store.Null(leader))
		}
		for _, f := range []struct {
			col string
			v   *string
		}{{"what", p.What}, {"uses", p.Uses}, {"now", p.Now}, {"next", p.Next}} {
			if f.v != nil {
				add(f.col, *f.v)
			}
		}
		if p.Name != nil {
			add("name", strings.TrimSpace(*p.Name))
		}
		add("updated_at", store.Now())
		args = append(args, id)
		if _, err := tx.ExecContext(ctx, `UPDATE departments SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
			return err
		}
		for _, r := range p.RepoDrop {
			if _, err := tx.ExecContext(ctx, `DELETE FROM department_repos WHERE department = ? AND repo = ?`, id, r); err != nil {
				return err
			}
		}
		return addRepos(ctx, tx, id, p.RepoAdd)
	})
	if err != nil {
		return Dept{}, err
	}
	return Get(ctx, db, id)
}

// Node 是部门树的一个节点。
type Node struct {
	Dept
	Points   int     `json:"points"`
	Children []*Node `json:"children,omitempty"`
}

// Tree 读全部部门搭成森林（顶层按建立先后）。
func Tree(ctx context.Context, q store.Querier) ([]*Node, error) {
	rows, err := q.QueryContext(ctx, `SELECT d.id, COALESCE(d.parent, ''), d.name, d.what, d.uses, d.now, d.next,
		COALESCE(d.leader, ''), d.created_at, d.updated_at, (SELECT count(*) FROM points p WHERE p.department = d.id)
		FROM departments d ORDER BY d.created_at, d.id LIMIT ?`, MaxDepts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []*Node
	for rows.Next() {
		n := &Node{}
		if err := rows.Scan(&n.ID, &n.Parent, &n.Name, &n.What, &n.Uses, &n.Now, &n.Next, &n.Leader,
			&n.CreatedAt, &n.UpdatedAt, &n.Points); err != nil {
			return nil, err
		}
		list = append(list, n)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return buildForest(list), nil
}

// buildForest 纯函数：按 Parent 挂成森林，保持输入顺序。
func buildForest(list []*Node) []*Node {
	byID := map[string]*Node{}
	for _, n := range list {
		byID[n.ID] = n
	}
	roots := []*Node{}
	for _, n := range list {
		if p := byID[n.Parent]; p != nil {
			p.Children = append(p.Children, n)
		} else {
			roots = append(roots, n)
		}
	}
	return roots
}

// NewPoint 是 point add 的输入。By 缺省为发起人。
type NewPoint struct {
	Text  string `json:"text"`
	Why   string `json:"why"`
	By    string `json:"by"`
	Check string `json:"check"`
	Pos   int    `json:"pos"`
}

func checkPoint(text, why, by, check *string) error {
	if text != nil {
		if err := checkText("text", *text, maxPointText, true); err != nil {
			return err
		}
	}
	for _, f := range []struct {
		name  string
		v     *string
		limit int
	}{{"why", why, maxPointWhy}, {"by", by, maxPointBy}, {"check", check, maxCheck}} {
		if f.v != nil {
			if err := checkText(f.name, *f.v, f.limit, false); err != nil {
				return err
			}
		}
	}
	return nil
}

func AddPoint(ctx context.Context, db *store.DB, dept string, in NewPoint, actor string) (Point, error) {
	if in.By == "" {
		in.By = actor
	}
	if err := checkPoint(&in.Text, &in.Why, &in.By, &in.Check); err != nil {
		return Point{}, err
	}
	var id string
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := Get(ctx, tx, dept); err != nil {
			return err
		}
		order, err := pointOrder(ctx, tx, dept)
		if err != nil {
			return err
		}
		if err := CheckRoom(dept, len(order)); err != nil {
			return err
		}
		if id, err = store.NextID(ctx, tx, "k"); err != nil {
			return err
		}
		next, err := InsertAt(order, id, in.Pos)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO points (id, department, pos, text, why, decided_by, check_ref,
			updated_by, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)`, id, dept, strings.TrimSpace(in.Text), in.Why,
			in.By, in.Check, actor, store.Now()); err != nil {
			return err
		}
		return writeOrder(ctx, tx, next)
	})
	if err != nil {
		return Point{}, err
	}
	return getPoint(ctx, db, id)
}

// PointPatch 是 point edit 的输入；Delete 为真时删掉这条（其余字段忽略）。
type PointPatch struct {
	Text   *string `json:"text,omitempty"`
	Why    *string `json:"why,omitempty"`
	By     *string `json:"by,omitempty"`
	Check  *string `json:"check,omitempty"`
	Pos    *int    `json:"pos,omitempty"`
	Delete bool    `json:"delete,omitempty"`
}

// EditPoint 改或删一条要点；删除时返回被删的那条。
func EditPoint(ctx context.Context, db *store.DB, id string, p PointPatch, actor string) (Point, error) {
	if !p.Delete && p.Text == nil && p.Why == nil && p.By == nil && p.Check == nil && p.Pos == nil {
		return Point{}, api.Usage("没有要改的字段").WithNext("atrium point edit --help")
	}
	if err := checkPoint(p.Text, p.Why, p.By, p.Check); err != nil {
		return Point{}, err
	}
	old, err := getPoint(ctx, db, id)
	if err != nil {
		return Point{}, err
	}
	err = db.Tx(ctx, func(tx *sql.Tx) error {
		order, err := pointOrder(ctx, tx, old.Org)
		if err != nil {
			return err
		}
		if p.Delete {
			if _, err := tx.ExecContext(ctx, `DELETE FROM points WHERE id = ?`, id); err != nil {
				return err
			}
			return writeOrder(ctx, tx, slices.DeleteFunc(order, func(s string) bool { return s == id }))
		}
		sets, args := []string{}, []any{}
		add := func(col string, v any) { sets, args = append(sets, col+" = ?"), append(args, v) }
		if p.Text != nil {
			add("text", strings.TrimSpace(*p.Text))
		}
		if p.Why != nil {
			add("why", *p.Why)
		}
		if p.By != nil {
			add("decided_by", *p.By)
		}
		if p.Check != nil {
			add("check_ref", *p.Check)
		}
		add("updated_by", actor)
		add("updated_at", store.Now())
		args = append(args, id)
		if _, err := tx.ExecContext(ctx, `UPDATE points SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
			return err
		}
		if p.Pos != nil {
			if *p.Pos == 0 {
				return api.Usage("--pos: 应为 1–%d", len(order))
			}
			next, err := InsertAt(order, id, *p.Pos)
			if err != nil {
				return err
			}
			return writeOrder(ctx, tx, next)
		}
		return nil
	})
	if err != nil || p.Delete {
		return old, err
	}
	return getPoint(ctx, db, id)
}

func getPoint(ctx context.Context, q store.Querier, id string) (Point, error) {
	var p Point
	err := q.QueryRowContext(ctx, `SELECT id, department, pos, text, why, decided_by, check_ref, updated_by, updated_at
		FROM points WHERE id = ?`, id).
		Scan(&p.ID, &p.Org, &p.Pos, &p.Text, &p.Why, &p.By, &p.Check, &p.UpdatedBy, &p.UpdatedAt)
	if store.IsNotFound(err) {
		return Point{}, api.NotFound("要点 %s 不存在", id)
	}
	return p, err
}

func pointOrder(ctx context.Context, q store.Querier, dept string) ([]string, error) {
	ps, err := Points(ctx, q, dept)
	if err != nil {
		return nil, err
	}
	order := make([]string, len(ps))
	for i, p := range ps {
		order[i] = p.ID
	}
	return order, nil
}

func writeOrder(ctx context.Context, tx *sql.Tx, order []string) error {
	for i, id := range order {
		if _, err := tx.ExecContext(ctx, `UPDATE points SET pos = ? WHERE id = ?`, i+1, id); err != nil {
			return err
		}
	}
	return nil
}
