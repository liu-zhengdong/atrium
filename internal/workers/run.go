package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// RunKind 是拉起记录在任务经历里的 kind。
const RunKind = "launch"

// 这次拉起的缘由。
const (
	WhyFirst   = "first"   // 分派任务队列里取出
	WhySame    = "same"    // 临时错误或长时间没进展后同一执行者重试
	WhySwitch  = "switch"  // 额度用尽、思考耗尽、临时错误再犯：换执行者
	WhyResume  = "resume"  // 本轮结束后带着补充说明继续会话
	WhyRestart = "restart" // 停掉带着补充说明重派
	WhyBounce  = "bounce"  // 交付被交回（冲突、检查没过、审阅打回、验收打回、交付检查未通过）后原执行者接着改；原因在 Cause
)

// Run 是一次拉起的记录（任务经历 kind "launch" 的正文）。gates 读 Risk、Dir、Worker；watch 读 PID、Log、Host。
type Run struct {
	N         int      `json:"n"` // 这件任务的第几次拉起（1 起），日志 run-N.log
	Why       string   `json:"why"`
	Cause     string   `json:"cause,omitempty"` // Why 为 bounce 时：冲突／检查没过／审阅打回／验收打回／交付检查未通过
	Worker    string   `json:"worker"`
	Host      string   `json:"host"`
	PID       int      `json:"pid,omitempty"` // 本机进程；远程为 0
	Dir       string   `json:"dir"`           // 工作目录（有仓库时是 worktree）
	Branch    string   `json:"branch,omitempty"`
	Log       string   `json:"log"`
	Risk      string   `json:"risk"`
	Secrets   []string `json:"secrets,omitempty"`    // 注入的凭据名（值不记）
	RemoteRun int      `json:"remote_run,omitempty"` // 远程机器上的轮号（hosts 记的）
	TellsUpto int64    `json:"tells_upto"`           // 提示词里已含到哪条补充说明（任务经历 id）
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

const logChunk = 256 * 1024

// ReadLog 读执行者日志到最后一个完整行；offset < 0 表示读末尾一段（从下一行开头起）。task log 用它按偏移读原文。
func ReadLog(path string, offset int64) (string, int64, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return "", max(offset, 0), nil
	}
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", 0, err
	}
	tail := offset < 0
	if tail {
		offset = max(st.Size()-64*1024, 0)
	}
	if offset > st.Size() {
		offset = st.Size()
	}
	buf := make([]byte, min(st.Size()-offset, logChunk))
	if _, err := f.ReadAt(buf, offset); err != nil && err != io.EOF {
		return "", 0, err
	}
	s := string(buf)
	if tail && offset > 0 {
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s, offset = s[i+1:], offset+int64(i+1)
		}
	}
	end := strings.LastIndexByte(s, '\n')
	if end < 0 {
		return "", offset, nil
	}
	return s[:end+1], offset + int64(end+1), nil
}
