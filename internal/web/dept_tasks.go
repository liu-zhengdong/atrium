package web

import (
	"context"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// deptTasks 是部门整棵子树里没结束的任务（含草稿），加上 3 天内结束的（最多 100 件；没结束的在前，各自最近的在前），
// 再补上它们的全部子孙（不论部门、不论多久前结束），排成树：一个目标拆成了哪几件都在它下面。
func deptTasks(ctx context.Context, q store.Querier, ix *orgIndex, id string) ([]Row, error) {
	ids := ix.subtree(id)
	marks := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids)+1)
	for _, d := range ids {
		args = append(args, d)
	}
	args = append(args, time.Now().Add(-72*time.Hour).UnixMilli())
	rows, err := q.QueryContext(ctx, `SELECT id FROM tasks WHERE department IN (`+marks+`)
		AND (finished_at IS NULL OR finished_at > ?) ORDER BY finished_at IS NOT NULL, updated_at DESC LIMIT 100`, args...)
	if err != nil {
		return nil, err
	}
	tids, err := scanIDs(rows)
	if err != nil {
		return nil, err
	}
	listed, err := getTasks(ctx, q, tids)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var tasks []ledger.Task
	for _, t := range listed {
		if !seen[t.ID] {
			seen[t.ID] = true
			tasks = append(tasks, t)
		}
		sub, err := ledger.Subtree(ctx, q, t.ID)
		if err != nil {
			return nil, err
		}
		for _, s := range sub[1:] {
			if !seen[s.ID] {
				seen[s.ID] = true
				tasks = append(tasks, s)
			}
		}
	}
	kids := countKids(tasks) // 每件列出的任务都补了整棵子树，子任务数是全的
	out := make([]Row, len(tasks))
	for i, t := range tasks {
		if out[i], err = rowOf(ctx, q, t, ix, kids[t.ID]); err != nil {
			return nil, err
		}
	}
	return nest(tasks, out), nil
}

// loadDraftCount 与今天页草稿链接一样取第一个根部门，只数目标任务树中的草稿根。
// 子任务跟随父任务归组，加载范围、排序和上限都由 deptTasks 统一决定。
func loadDraftCount(ctx context.Context, q store.Querier, ix *orgIndex) (int, error) {
	for _, d := range ix.list {
		if d.Parent != "" {
			continue
		}
		rows, err := deptTasks(ctx, q, ix, d.ID)
		if err != nil {
			return 0, err
		}
		n := 0
		for _, r := range rows {
			if r.State == "draft" {
				n++
			}
		}
		return n, nil
	}
	return 0, nil
}
