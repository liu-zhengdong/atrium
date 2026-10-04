package workers

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// TaskSampleMinimum 是展示统计分位的最低完整任务数，不代表预测可靠性保证。
const TaskSampleMinimum = 5

// TaskMetric 按任务累计后统计；覆盖分母为同组合、窗口内创建且已完成的任务。
type TaskMetric struct {
	Name      string   `json:"name"`
	Unit      string   `json:"unit"`
	Samples   int      `json:"samples"`
	Median    *float64 `json:"median"`
	P75       *float64 `json:"p75"`
	Estimated int      `json:"estimated"`
}

type TaskConsumption struct {
	Tasks   int          `json:"tasks"`
	Mixed   int          `json:"mixed"`
	Metrics []TaskMetric `json:"metrics"`
	Text    string       `json:"text"`
}

// ReadTaskConsumptions 只读取已完成且整个任务都落在窗口内的记录。
// 不扫描日志、不补算单价；换过组合的任务不能归因给单一候选。
func ReadTaskConsumptions(ctx context.Context, db store.Querier, attempts []Attempt, since int64, key func(string) string) (map[string]TaskConsumption, error) {
	completed := map[string]bool{}
	var cursor string
	for {
		rows, err := db.QueryContext(ctx, `SELECT id FROM tasks WHERE id > ? AND status = 'done' AND created_at >= ? ORDER BY id LIMIT 1000`, cursor, since)
		if err != nil {
			return nil, err
		}
		n := 0
		for rows.Next() {
			if err := rows.Scan(&cursor); err != nil {
				rows.Close()
				return nil, err
			}
			completed[cursor] = true
			n++
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		if n < 1000 {
			break
		}
	}
	return taskConsumptions(attempts, completed, key), nil
}

func taskConsumptions(attempts []Attempt, completed map[string]bool, key func(string) string) map[string]TaskConsumption {
	byTask := map[string][]Attempt{}
	for _, a := range attempts {
		if completed[a.Task] {
			byTask[a.Task] = append(byTask[a.Task], a)
		}
	}
	groups := map[string][][]Attempt{}
	mixed := map[string]int{}
	for _, ls := range byTask {
		combos := map[string]bool{}
		for _, a := range ls {
			combos[key(a.Worker)] = true
		}
		if len(combos) != 1 {
			for combo := range combos {
				mixed[combo]++
			}
			continue
		}
		combo := key(ls[0].Worker)
		groups[combo] = append(groups[combo], ls)
	}
	out := map[string]TaskConsumption{}
	for combo := range mixed {
		out[combo] = TaskConsumption{Mixed: mixed[combo]}
	}
	for combo, tasks := range groups {
		c := TaskConsumption{Tasks: len(tasks), Mixed: mixed[combo]}
		for _, ls := range tasks {
			sort.Slice(ls, func(i, j int) bool { return ls[i].N < ls[j].N })
		}
		for i, name := range []string{"折合花费", "输入", "输出", "缓存读", "缓存写"} {
			unit := "token"
			if i == 0 {
				unit = "USD"
			}
			m := TaskMetric{Name: name, Unit: unit}
			var values []float64
			for _, ls := range tasks {
				total, valid, estimated := 0.0, true, false
				for index, a := range ls {
					v := taskMetricValue(a.Usage, i)
					if a.N != index+1 || a.Outcome == "" || v == nil || *v < 0 || math.IsNaN(*v) || math.IsInf(*v, 0) {
						valid = false
						break
					}
					total += *v
					estimated = estimated || (i == 0 && a.Usage.Source == "estimate")
				}
				if valid && !math.IsInf(total, 0) {
					values = append(values, total)
					if estimated {
						m.Estimated++
					}
				}
			}
			m.Samples = len(values)
			if len(values) >= TaskSampleMinimum {
				sort.Float64s(values)
				// P50/P75 用线性插值：位置 (n-1)*p，不是最大值或上界。
				med, upper := taskQuantile(values, 0.5), taskQuantile(values, 0.75)
				m.Median, m.P75 = &med, &upper
			}
			c.Metrics = append(c.Metrics, m)
		}
		out[combo] = c
	}
	for combo, c := range out {
		c.Text = c.String()
		out[combo] = c
	}
	return out
}

func taskMetricValue(u Usage, i int) *float64 {
	if i == 0 {
		if len(u.Missing) > 0 {
			return nil
		}
		return u.InUSD()
	}
	n := []*int64{u.Input, u.Output, u.CacheRead, u.CacheWrite}[i-1]
	if n == nil {
		return nil
	}
	v := float64(*n)
	return &v
}

func taskQuantile(v []float64, p float64) float64 {
	pos := float64(len(v)-1) * p
	low := int(pos)
	high := min(low+1, len(v)-1)
	return v[low] + (v[high]-v[low])*(pos-float64(low))
}

func (c TaskConsumption) String() string {
	parts := []string{fmt.Sprintf("%d 件已完成同组合任务", c.Tasks)}
	for _, m := range c.Metrics {
		text := fmt.Sprintf("%s 未知", m.Unit)
		if m.Median != nil {
			text = fmt.Sprintf("中位 %.6g / P75 %.6g %s", *m.Median, *m.P75, m.Unit)
		}
		note := fmt.Sprintf("完整读数 %d/%d", m.Samples, c.Tasks)
		if m.Estimated > 0 {
			note += fmt.Sprintf("；%d 件含单价估算", m.Estimated)
		}
		parts = append(parts, fmt.Sprintf("%s %s（%s）", m.Name, text, note))
	}
	if c.Tasks == 0 {
		parts = append(parts, "未知（无完整任务样本）")
	}
	if c.Mixed > 0 {
		parts = append(parts, fmt.Sprintf("排除 %d 件换组合任务", c.Mixed))
	}
	return strings.Join(parts, " · ")
}
