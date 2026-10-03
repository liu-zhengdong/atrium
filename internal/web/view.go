package web

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/watch"
)

// 本文件是网页的纯判定：任务在步骤条里走到哪、行首行尾怎么写。当前等待对象用 watch.HolderOf，不在这里另判。

// allSteps 是有仓库的任务要走的五步。
var allSteps = []string{"分派任务", "执行", "验收", "合入", "上线"}

// stepsOf 是任务详情的步骤条：没有仓库的交付不经 PR，只到「验收」。
func stepsOf(t ledger.Task) []string {
	if t.Repo == "" {
		return allSteps[:3]
	}
	return allSteps
}

// step 返回任务当前在第几步（0 起）；done 的任务返回步数（全部走完）。
func step(t ledger.Task) int {
	switch t.Status {
	case ledger.Done:
		return len(stepsOf(t))
	case ledger.Draft, ledger.Todo, ledger.Queued:
		return 0
	}
	switch t.Stage {
	case ledger.StageGate, ledger.StageReview, ledger.StageAccept:
		return 2
	case ledger.StageMerge:
		return 3
	case ledger.StageMerged, ledger.StageReleased:
		return 4
	}
	if t.Status == ledger.Running {
		return 1
	}
	// failed / blocked / cancelled 停在做到的那一步：有 PR 算到了验收，否则停在执行。
	if t.PR != "" {
		return 2
	}
	if t.Worker != "" {
		return 1
	}
	return 0
}

// state 是列表行前的状态点：run 在做（含拆成子任务在做的）、idle 排队或没开始、draft 草稿、bad 卡住或失败、done 完成、off 取消。
// h 是 watch.HolderOf 的结果，自身待派的只按它看是不是子任务在做。
func state(t ledger.Task, h watch.Holder) string {
	if h.Kind == "children" {
		return "run"
	}
	switch t.Status {
	case ledger.Draft:
		return "draft"
	case ledger.Running:
		return "run"
	case ledger.Blocked, ledger.Failed:
		return "bad"
	case ledger.Done:
		return "done"
	case ledger.Cancelled:
		return "off"
	}
	return "idle"
}

// finishedText 是已结束任务在详情里的一句话（没结束的由 watch.HolderOf 判）。
func finishedText(t ledger.Task) string {
	switch {
	case t.Status == ledger.Cancelled:
		return "已取消"
	case t.Stage == ledger.StageReleased:
		return "已上线"
	case t.Stage == ledger.StageMerged:
		return "已合入"
	}
	return "已完成"
}

// who 是列表行尾的短标签：结束了的按结果说，没结束的取等待对象的短标签（watch.HolderOf）；草稿自成一组，组名已说明。
func who(t ledger.Task, h watch.Holder) string {
	switch t.Status {
	case ledger.Cancelled:
		return "取消"
	case ledger.Done:
		switch t.Stage {
		case ledger.StageReleased:
			return "已上线"
		case ledger.StageMerged:
			return "已合入"
		}
		return "完成"
	}
	return h.Short
}

// nest 把任务排成森林：父任务也在 tasks 里的，挂到父任务的 Kids 下（按建立先后）；其余是根，保持 tasks 里的先后。
// rows[i] 是 tasks[i] 的行。父任务建立后不能改，树不会成环。
func nest(tasks []ledger.Task, rows []Row) []Row {
	in := map[string]bool{}
	for _, t := range tasks {
		in[t.ID] = true
	}
	kids := map[string][]int{}
	var roots []int
	for i, t := range tasks {
		if in[t.Parent] {
			kids[t.Parent] = append(kids[t.Parent], i)
		} else {
			roots = append(roots, i)
		}
	}
	var build func(i int) Row
	build = func(i int) Row {
		r := rows[i]
		ks := kids[tasks[i].ID]
		sort.Slice(ks, func(a, b int) bool { return earlier(tasks[ks[a]], tasks[ks[b]]) })
		for _, k := range ks {
			r.Kids = append(r.Kids, build(k))
		}
		return r
	}
	out := make([]Row, 0, len(roots))
	for _, i := range roots {
		out = append(out, build(i))
	}
	return out
}

// earlier：先建立的在前；同一毫秒建的按短号（发号有先后）。
func earlier(a, b ledger.Task) bool {
	if a.CreatedAt != b.CreatedAt {
		return a.CreatedAt < b.CreatedAt
	}
	na, _ := strconv.Atoi(strings.TrimPrefix(a.ID, "t"))
	nb, _ := strconv.Atoi(strings.TrimPrefix(b.ID, "t"))
	return na < nb
}

// startOfDay 是 now 所在本地日期的零点（Unix 毫秒），「今天完成」从这里算。
func startOfDay(now time.Time) int64 {
	y, m, d := now.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, now.Location()).UnixMilli()
}

// slots 是机器的并发空位：登记的上限优先，其次机器按核数报的上限，都没有算 1。
func slots(h hosts.Host) int {
	switch {
	case h.MaxRunning > 0:
		return h.MaxRunning
	case h.Info != nil && h.Info.MaxWorkers > 0:
		return h.Info.MaxWorkers
	}
	return 1
}

// topGroup 返回 id 所在的「一级部门」：根的直接下级（id 本身是根或一级时返回自己）。
// 今天页按它把在做的任务分组。
func topGroup(parents map[string]string, id string) string {
	for {
		p := parents[id]
		if p == "" || parents[p] == "" {
			return id
		}
		id = p
	}
}

// eventText 取一条经历里写给人看的原因（状态变化的 note、备注正文）；没有返回空串。
func eventText(e ledger.TaskEvent) string {
	switch e.Kind {
	case "note":
		return e.Body
	case "created", "edited", "facts":
		return ""
	}
	var body struct {
		Note string `json:"note"`
	}
	if json.Unmarshal([]byte(e.Body), &body) == nil {
		return body.Note
	}
	return ""
}
