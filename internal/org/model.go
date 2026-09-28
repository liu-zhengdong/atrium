package org

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/api"
)

// 上限表：会增长的东西都有上限。满了先合并、删最不值的、下沉或拆分，最后才提高上限。
const (
	MaxDepth     = 5   // 部门树深
	MaxPoints    = 7   // 每部门要点
	MaxRepos     = 20  // 每部门仓库
	MaxDepts     = 500 // 全部部门（一次读全树的上限）
	maxName      = 40
	maxIntro     = 300 // what/uses/now/next 各自
	maxPointText = 200
	maxPointWhy  = 300
	maxPointBy   = 40
	maxCheck     = 300
)

func checkText(field, v string, limit int, required bool) error {
	if required && strings.TrimSpace(v) == "" {
		return api.Usage("--%s: 不能为空", field)
	}
	if n := utf8.RuneCountInString(v); n > limit {
		return api.Usage("--%s: 最多 %d 字，收到 %d 字", field, limit, n)
	}
	return nil
}

// Depth 是部门在树里的层数（顶层为 1）。parents：部门 → 上级（顶层为空串）。
func Depth(parents map[string]string, id string) int {
	d := 0
	for cur := id; cur != "" && d <= len(parents); cur = parents[cur] {
		d++
	}
	return d
}

// height 是以 id 为根的子树层数（叶子为 1）。
func height(parents map[string]string, id string) int {
	h := 1
	for child, p := range parents {
		if p == id {
			h = max(h, height(parents, child)+1)
		}
	}
	return h
}

// CheckPlace 判定把部门 id（新建时为空）放到 parent 下是否可以：不成环、整棵子树不超过 MaxDepth。
func CheckPlace(parents map[string]string, id, parent string) error {
	if parent == "" {
		if id != "" && height(parents, id) > MaxDepth {
			return api.Usage("部门树最多 %d 层", MaxDepth)
		}
		return nil
	}
	if id != "" {
		for cur := parent; cur != ""; cur = parents[cur] {
			if cur == id {
				return api.Usage("--parent: %s 是 %s 自己或它的下属，不能当上级", parent, id)
			}
		}
	}
	sub := 1
	if id != "" {
		sub = height(parents, id)
	}
	if Depth(parents, parent)+sub > MaxDepth {
		return api.Limit("atrium org tree",
			"部门树最多 %d 层：放到 %s 下会到第 %d 层。把这块并进上级，或挂到更浅的部门下",
			MaxDepth, parent, Depth(parents, parent)+sub)
	}
	return nil
}

// InsertAt 把 id 放到 order 的第 pos 位（1 起；0 表示末尾），返回新顺序。id 原在 order 里则先移出。
func InsertAt(order []string, id string, pos int) ([]string, error) {
	rest := slices.DeleteFunc(slices.Clone(order), func(s string) bool { return s == id })
	if pos == 0 {
		pos = len(rest) + 1
	}
	if pos < 1 || pos > len(rest)+1 {
		return nil, api.Usage("--pos: 应为 1–%d", len(rest)+1)
	}
	return slices.Insert(rest, pos-1, id), nil
}

// CheckRoom 判定部门还能不能再加一条要点；满了告诉怎么腾地方。
func CheckRoom(dept string, count int) error {
	if count < MaxPoints {
		return nil
	}
	return api.Limit("atrium org show "+dept,
		"部门 %s 已有 %d 条要点（上限 %d）：先合并相近的（atrium point edit kN --text …）、"+
			"删掉最不值的（atrium point edit kN --delete），或下沉到子部门", dept, count, MaxPoints)
}

// ChainLine 是派活时附给执行者的一行：「k3（o1）规矩——为什么」。
func ChainLine(p Point) string {
	s := fmt.Sprintf("%s（%s）%s", p.ID, p.Org, p.Text)
	if p.Why != "" {
		s += "——" + p.Why
	}
	return s
}
