package dispatch

import (
	"sync"

	"github.com/liu-zhengdong/atrium/internal/workers"
)

// proc 是本机一个在跑的执行者进程（自己拉起的，或服务重启后继续跟进的）。
type proc struct {
	binding *workers.ExecutionBinding // 本次启动事实；adopt 后未知，不反推账号
	task    string
	run     workers.Run
	adapter *workers.Driver
	remote  bool
	lost    bool // 只由等待退出的 goroutine 写入并用于收尾

	mu      sync.Mutex
	stopFor string // 运行时停的：restart（带着补充说明重派）、gone（任务已不在跑）
	done    chan struct{}
}

func (p *proc) setStop(why string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopFor == "" {
		p.stopFor = why
	}
}

func (p *proc) stopReason() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stopFor
}
