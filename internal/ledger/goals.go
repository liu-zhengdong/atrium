package ledger

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// 三个目标各一个能看的数（README「目标」一节的检验方法）：
//   - 纠正（像你一样判断）：来源为用户纠正的草稿条数，另给每 10 件完成的活几次；
//   - 认可（自己找事）：拍过板的选项单里，被选中的项占几成；
//   - 复发（越做越好）：新草稿归进的类里，它建之前已有完成的任务，记一次。
// 判定在纯函数 Measure，ReadGoals 只管读。

// Week 是「近 7 天」的长度（毫秒）。
const Week = 7 * 24 * 60 * 60 * 1000

// Finding 是带来源或类的一件任务。
type Finding struct {
	ID       string
	Source   Source
	Class    string
	Created  int64
	Finished int64 // 完成的时刻；没完成为 0
}

// Count 是近 7 天与累计的两个数。
type Count struct{ Week, All int }

// GoalInput 是 Measure 的全部材料。
type GoalInput struct {
	Now      int64
	Findings []Finding
	Done     Count // 完成的任务
	Offered  Count // 拍过板的选项单里的项（按拍板时刻）
	Picked   Count // 其中被选中的
}

// Window 是一段时间里的三个数。
type Window struct {
	Corrections int      `json:"corrections"`
	Done        int      `json:"done"`
	Picked      int      `json:"picked"`
	Offered     int      `json:"offered"`
	Recurrences int      `json:"recurrences"`
	Recurred    []string `json:"recurred"` // 复发的草稿
	Text        string   `json:"text"`     // 「纠正 3（每 10 件 1.2）· 认可 4/6 · 复发 1」
}

// Goals 是近 7 天与累计。
type Goals struct {
	Week Window `json:"week"`
	All  Window `json:"all"`
}

// Line 是 top 里的一行（网页不用 Text，按三个数自己排成一个目标一行）。
func (g Goals) Line() string { return "近 7 天 " + g.Week.Text + " ｜ 累计 " + g.All.Text }

// Measure 纯函数：算三个数。
func Measure(in GoalInput) Goals {
	since := in.Now - Week
	g := Goals{
		Week: Window{Done: in.Done.Week, Offered: in.Offered.Week, Picked: in.Picked.Week, Recurred: []string{}},
		All:  Window{Done: in.Done.All, Offered: in.Offered.All, Picked: in.Picked.All, Recurred: []string{}},
	}
	// 每类最早完成的时刻：新草稿建在它之后就是复发（任务总是建了才完成，不会算到自己头上）。
	firstDone := map[string]int64{}
	for _, f := range in.Findings {
		if f.Class != "" && f.Finished != 0 && (firstDone[f.Class] == 0 || f.Finished < firstDone[f.Class]) {
			firstDone[f.Class] = f.Finished
		}
	}
	for _, f := range in.Findings {
		recent := f.Created >= since
		if f.Source == SourceUser {
			g.All.Corrections++
			if recent {
				g.Week.Corrections++
			}
		}
		if first := firstDone[f.Class]; first == 0 || first >= f.Created {
			continue
		}
		g.All.Recurrences++
		g.All.Recurred = append(g.All.Recurred, f.ID)
		if recent {
			g.Week.Recurrences++
			g.Week.Recurred = append(g.Week.Recurred, f.ID)
		}
	}
	g.Week.Text, g.All.Text = g.Week.text(), g.All.text()
	return g
}

func (w Window) text() string {
	per := "还没有完成的活"
	if w.Done > 0 {
		per = "每 10 件 " + strconv.FormatFloat(float64(w.Corrections)*10/float64(w.Done), 'f', 1, 64)
	}
	picked := "—（还没有拍板的选项单）"
	if w.Offered > 0 {
		picked = fmt.Sprintf("%d/%d", w.Picked, w.Offered)
	}
	s := fmt.Sprintf("纠正 %d（%s）· 认可 %s · 复发 %d", w.Corrections, per, picked, w.Recurrences)
	return strings.ReplaceAll(s, "） ·", "）·") // 全角括号后不空格
}

// maxFindings 是一次读出的带来源或类的任务的技术上限（超了报错，不少给）。
const maxFindings = 10000

// ReadGoals 读账本与选项单，算三个数。
func ReadGoals(ctx context.Context, q store.Querier, now int64) (Goals, error) {
	since := now - Week
	in := GoalInput{Now: now}
	rows, err := q.QueryContext(ctx, `SELECT t.id, f.source, f.class, t.created_at, COALESCE(t.finished_at, 0) * (t.status = 'done')
		FROM task_findings f JOIN tasks t ON t.id = f.task ORDER BY t.created_at LIMIT ?`, maxFindings+1)
	if err != nil {
		return Goals{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var f Finding
		if err := rows.Scan(&f.ID, &f.Source, &f.Class, &f.Created, &f.Finished); err != nil {
			return Goals{}, err
		}
		in.Findings = append(in.Findings, f)
	}
	if err := rows.Err(); err != nil {
		return Goals{}, err
	}
	if len(in.Findings) > maxFindings {
		return Goals{}, fmt.Errorf("带来源或类的任务超过 %d 件，三个目标的数要改成分段算", maxFindings)
	}
	if err := q.QueryRowContext(ctx, `SELECT COALESCE(sum(finished_at >= ?), 0), count(*) FROM tasks WHERE status = 'done'`, since).
		Scan(&in.Done.Week, &in.Done.All); err != nil {
		return Goals{}, err
	}
	err = q.QueryRowContext(ctx, `SELECT COALESCE(sum(c.decided_at >= ?), 0), count(*),
		COALESCE(sum(c.decided_at >= ? AND o.task IS NOT NULL), 0), COALESCE(sum(o.task IS NOT NULL), 0)
		FROM choice_options o JOIN choices c ON c.id = o.choice WHERE c.status <> 'open'`, since, since).
		Scan(&in.Offered.Week, &in.Offered.All, &in.Picked.Week, &in.Picked.All)
	if err != nil {
		return Goals{}, err
	}
	return Measure(in), nil
}
