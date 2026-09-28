package web

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
)

// hub 把「库变了」推给所有打开的网页。两路信号：本进程的任务写入（ledger.Changed，立即）与
// 库的 data_version（别的连接、别的进程提交后会变；只在有人在看时每秒问一次，一条 PRAGMA）。
type hub struct {
	mu   sync.Mutex
	subs map[chan struct{}]struct{}
}

const (
	pollEvery = time.Second
	keepalive = 25 * time.Second
)

func newHub() *hub { return &hub{subs: map[chan struct{}]struct{}{}} }

func (h *hub) watchers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

func (h *hub) subscribe() chan struct{} {
	ch := make(chan struct{}, 1)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *hub) unsubscribe(ch chan struct{}) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

func (h *hub) broadcast() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- struct{}{}:
		default: // 已有一条没取走的「变了」，合并
		}
	}
}

// run 是后台循环：ctx 取消时返回。
func (h *hub) run(ctx context.Context, env *app.Env) error {
	conn, err := env.DB.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	last := int64(-1)
	tick := time.NewTicker(pollEvery)
	defer tick.Stop()
	for {
		changed := ledger.Changed()
		select {
		case <-ctx.Done():
			return nil
		case <-changed:
			h.broadcast()
		case <-tick.C:
			if h.watchers() == 0 {
				last = -1
				continue
			}
			v, err := dataVersion(ctx, conn)
			if err != nil {
				return err
			}
			if last >= 0 && v != last {
				h.broadcast()
			}
			last = v
		}
	}
}

// dataVersion 必须在同一条连接上反复问：别的连接提交后它才会变。
func dataVersion(ctx context.Context, conn *sql.Conn) (int64, error) {
	var v int64
	err := conn.QueryRowContext(ctx, `PRAGMA data_version`).Scan(&v)
	return v, err
}

// serve 是 GET /ui/stream：先发一条 ready，之后每次变化发 changed；定时发注释保活。
func (h *hub) serve(rw http.ResponseWriter, req *http.Request) {
	fl, ok := rw.(http.Flusher)
	if !ok {
		http.Error(rw, "不支持流式响应", http.StatusInternalServerError)
		return
	}
	rw.Header().Set("Content-Type", "text/event-stream")
	rw.Header().Set("Cache-Control", "no-store")
	ch := h.subscribe()
	defer h.unsubscribe(ch)
	fmt.Fprint(rw, "retry: 3000\ndata: ready\n\n")
	fl.Flush()
	ping := time.NewTicker(keepalive)
	defer ping.Stop()
	for {
		select {
		case <-req.Context().Done():
			return
		case <-ch:
			fmt.Fprint(rw, "data: changed\n\n")
		case <-ping.C:
			fmt.Fprint(rw, ": ping\n\n")
		}
		fl.Flush()
	}
}
