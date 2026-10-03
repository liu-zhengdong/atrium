package dispatch

import (
	"bufio"
	"io"
	"os"
	"strings"
	"sync"
	"time"

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
	stdin   *os.File        // 即时补充说明的写端；nil 表示没有或已关
	pending map[string]bool // 已写入、还没回显的补充说明 uuid
	stopFor string          // 运行时停的：restart（带着补充说明重派）、gone（任务已不在跑）
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

// send 即时写一条补充说明；写端已关返回 false。
func (p *proc) send(text, uuid string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stdin == nil {
		return false
	}
	if _, err := p.stdin.Write(workers.UserLine(text, uuid)); err != nil {
		p.stdin.Close()
		p.stdin = nil
		return false
	}
	p.pending[uuid] = true
	return true
}

func (p *proc) closeStdin() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stdin != nil {
		p.stdin.Close()
		p.stdin = nil
	}
}

// LineSignal 判 stream-json 日志的一行（纯函数）：本轮收尾（result）或补充说明回显（isReplay 的 user 消息，给 uuid）。
func LineSignal(line string) (result bool, echo string) {
	if !strings.HasPrefix(line, "{") || (!strings.Contains(line, `"type":"result"`) && !strings.Contains(line, `"isReplay":true`)) {
		return false, ""
	}
	e := map[string]any{}
	if err := jsonUnmarshal(line, &e); err != nil {
		return false, ""
	}
	if e["type"] == "result" {
		return true, ""
	}
	if e["type"] == "user" && e["isReplay"] == true {
		u, _ := e["uuid"].(string)
		return false, u
	}
	return false, ""
}

// watchLive 跟着日志：补充说明回显了就记下；本轮收尾且没有待回显的补充说明时关掉标准输入，执行者随之退出。
func (p *proc) watchLive(onEcho func(uuid string)) {
	f, err := os.Open(p.run.Log)
	if err != nil {
		p.closeStdin()
		return
	}
	defer f.Close()
	r := bufio.NewReader(f)
	var partial string
	for {
		line, err := r.ReadString('\n')
		if err == io.EOF {
			partial += line
			select {
			case <-p.done:
				return
			case <-time.After(300 * time.Millisecond):
			}
			continue
		}
		if err != nil {
			p.closeStdin()
			return
		}
		line, partial = partial+line, ""
		result, echo := LineSignal(strings.TrimSpace(line))
		p.mu.Lock()
		if echo != "" && p.pending[echo] {
			delete(p.pending, echo)
			p.mu.Unlock()
			onEcho(echo)
			p.mu.Lock()
		}
		idle := len(p.pending) == 0
		p.mu.Unlock()
		if result && idle {
			p.closeStdin()
		}
	}
}
