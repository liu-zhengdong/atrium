// Package events：待投递事件落库、等待、确认、租约。
//
// 第一波只实现 Emit（落库）；投递对象解析（任务所属部门往上最近的负责人，没有投秘书）、
// events wait/ack 命令与租约由第二波补在本包里。其他包只调 Emit，不直接写 events 表。
package events

import (
	"context"
	"encoding/json"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 事件种类。新增种类在这里加常量，别处不写字符串字面量。
const (
	TaskStatus = "task.status" // 任务状态变化；Body: {"from","to","stage"}
	Overdue    = "overdue"     // 持球人到期（watch 包发）
)

// Event 是一条待投递事件。Target 留空表示交给 events 包按部门解析投递对象。
type Event struct {
	Kind   string
	Task   string
	Dept   string
	Target string
	Body   any
}

// Emit 在调用方的事务里落一条事件：与引起它的状态变化同生同死。
func Emit(ctx context.Context, q store.Querier, e Event) error {
	body := ""
	if e.Body != nil {
		raw, err := json.Marshal(e.Body)
		if err != nil {
			return err
		}
		body = string(raw)
	}
	_, err := q.ExecContext(ctx,
		`INSERT INTO events (at, kind, task, department, target, body) VALUES (?, ?, ?, ?, ?, ?)`,
		store.Now(), e.Kind, store.Null(e.Task), store.Null(e.Dept), e.Target, body)
	return err
}

// Module 桩：第二波在这里注册 events wait/ack 命令与路由。
func Module() app.Module { return app.Module{Name: "events"} }
