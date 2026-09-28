package workers

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// RunKind 是拉起记录在任务经历里的 kind。
const RunKind = "launch"

// 这次拉起的缘由。
const (
	WhyFirst   = "first"   // 派活队列里取出
	WhySame    = "same"    // 临时错误或卡死后同一执行者重试
	WhySwitch  = "switch"  // 额度用尽、思考耗尽、临时错误再犯：换执行者
	WhyResume  = "resume"  // 本轮结束后带着捎话续上会话
	WhyRestart = "restart" // 停掉带着捎话重派
)

// Run 是一次拉起的记录（任务经历 kind "launch" 的正文）。gates 读 Risk、Dir、Worker；watch 读 PID、Log、Host。
type Run struct {
	N         int      `json:"n"` // 这件任务的第几次拉起（1 起），日志 run-N.log
	Why       string   `json:"why"`
	Worker    string   `json:"worker"`
	Host      string   `json:"host"`
	PID       int      `json:"pid,omitempty"` // 本机进程；远程为 0
	Dir       string   `json:"dir"`           // 工作目录（有仓库时是 worktree）
	Branch    string   `json:"branch,omitempty"`
	Log       string   `json:"log"`
	Risk      string   `json:"risk"`
	Secrets   []string `json:"secrets,omitempty"`    // 注入的凭据名（值不记）
	RemoteRun int      `json:"remote_run,omitempty"` // 远程机器上的轮号（hosts 记的）
	TellsUpto int64    `json:"tells_upto"`           // 提示词里已含到哪条捎话（任务经历 id）
	At        int64    `json:"at"`
}

// Runs 取任务最近 limit 次拉起（时间正序）。
func Runs(ctx context.Context, q store.Querier, task string, limit int) ([]Run, error) {
	rows, err := q.QueryContext(ctx, `SELECT body FROM (SELECT id, body FROM task_events WHERE task = ? AND kind = ?
		ORDER BY id DESC LIMIT ?) ORDER BY id`, task, RunKind, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Run
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			return nil, err
		}
		var r Run
		if err := json.Unmarshal([]byte(body), &r); err != nil {
			return nil, fmt.Errorf("任务 %s 的拉起记录坏了：%w", task, err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// LastRun 取最近一次拉起；从没拉起过返回 nil。
func LastRun(ctx context.Context, q store.Querier, task string) (*Run, error) {
	rs, err := Runs(ctx, q, task, 1)
	if err != nil || len(rs) == 0 {
		return nil, err
	}
	return &rs[0], nil
}
