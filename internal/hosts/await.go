package hosts

import (
	"context"
	"fmt"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
)

// awayGrace 是「没在领指令」要连续多久，才算这会儿不在，而不是两轮长轮询之间的空隙。
// 长轮询本身算在领；空隙只是把刚拿到的指令交出去再发下一轮请求。
var awayGrace = 3 * time.Second

// awayTick 是查看还在不在领指令的间隔（测试调短）。
var awayTick = 100 * time.Millisecond

// again 判断这次等不到回执要不要下一轮再试。
// 还在领指令：不再试，这次就是没完成。
// 还没领走：再试（拉起、查询、回收都还没开始）。
// 已经领走但机器不在了：只有查询再试（只读）；拉起和回收可能已经改了机器上的状态。
func again(kind string, taken, polling bool) bool {
	if polling {
		return false
	}
	if !taken {
		return true
	}
	return kind == "query"
}

func notNow(host string) error {
	return app.NotNow(fmt.Errorf("%s 这会儿没在领指令，下一轮再试", host))
}

func unanswered(host, kind string, work time.Duration, taken bool) error {
	what := "指令"
	switch kind {
	case "launch":
		what = "拉起指令"
	case "query":
		what = "查询"
	case "reclaim":
		what = "回收"
	}
	if taken {
		return fmt.Errorf("%s 领走了%s，%s 内没回执", host, what, work)
	}
	return fmt.Errorf("%s 在 %s 内没领走%s", host, work, what)
}

// waitPolling 等到这台开始领指令。一直没有就返回 NotNow，调用方先不改任务状态。
func waitPolling(ctx context.Context, host string) error {
	if theHub.isPolling(host) {
		return nil
	}
	timer := time.NewTimer(awayGrace)
	defer timer.Stop()
	tick := time.NewTicker(awayTick)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			if theHub.isPolling(host) {
				return nil
			}
			return notNow(host)
		case <-tick.C:
			if theHub.isPolling(host) {
				return nil
			}
		}
	}
}

// call 下发一条指令并等回执。机器没在领指令时不把指令留在队列里。
func call(ctx context.Context, host string, cmd Command, work time.Duration) (Ack, error) {
	if err := waitPolling(ctx, host); err != nil {
		return Ack{}, err
	}
	id, ackc := theHub.push(host, cmd)
	return waitAck(ctx, host, id, ackc, work, cmd.Kind)
}

// waitAck 等回执。机器走开且这次可以重做时撤回指令并返回 NotNow；否则等到 work。
func waitAck(ctx context.Context, host, id string, ackc <-chan Ack, work time.Duration, kind string) (Ack, error) {
	timer := time.NewTimer(work)
	defer timer.Stop()
	tick := time.NewTicker(awayTick)
	defer tick.Stop()
	var quiet time.Time
	for {
		select {
		case ack := <-ackc:
			return ack, nil
		case <-ctx.Done():
			theHub.withdraw(host, id)
			return Ack{}, ctx.Err()
		case <-tick.C:
			if err, ok := awayLongEnough(host, id, kind, &quiet); ok {
				return Ack{}, err
			}
		case <-timer.C:
			taken := !theHub.withdraw(host, id)
			if again(kind, taken, theHub.isPolling(host)) {
				return Ack{}, notNow(host)
			}
			return Ack{}, unanswered(host, kind, work, taken)
		}
	}
}

// awayLongEnough 在机器连续不领指令超过 awayGrace、且这次可以重做时撤回还在队列里的指令。
// 查询已经领走的，回执通道也撤掉（只读，下一轮重查）。拉起已经领走的留着，继续等回执。
func awayLongEnough(host, id, kind string, quiet *time.Time) (error, bool) {
	if theHub.isPolling(host) {
		*quiet = time.Time{}
		return nil, false
	}
	if quiet.IsZero() {
		*quiet = time.Now()
		return nil, false
	}
	if time.Since(*quiet) < awayGrace {
		return nil, false
	}
	if theHub.isPolling(host) {
		*quiet = time.Time{}
		return nil, false
	}
	taken := !theHub.pending(host, id)
	if !again(kind, taken, false) {
		return nil, false
	}
	if !taken {
		if !theHub.dropQueued(host, id) {
			return nil, false // 刚被领走，改等回执
		}
		return notNow(host), true
	}
	theHub.withdraw(host, id)
	return notNow(host), true
}
