package dispatch

import (
	"context"
	"os"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// ReadLog 读最近一次拉起的日志：offset < 0 读末尾一段；否则从 offset 读，wait 时没有新内容就等（有新内容、执行者退出或超时）。
func ReadLog(ctx context.Context, env *app.Env, id string, offset int64, wait time.Duration) (LogChunk, error) {
	return readRunLog(ctx, env, id, 0, offset, wait, false)
}

func readRunLog(ctx context.Context, env *app.Env, id string, n int, offset int64, wait time.Duration, complete bool) (LogChunk, error) {
	d := get(env)
	if _, err := ledger.Get(ctx, env.DB, id); err != nil {
		return LogChunk{}, err
	}
	run, err := workers.RunAt(ctx, env.DB, id, n)
	if err != nil {
		return LogChunk{}, err
	}
	if run == nil {
		return LogChunk{}, api.NotFound("%s 没有第 %d 轮拉起记录", id, n).WithNext("atrium task show " + id)
	}
	c := LogChunk{Task: id, Run: run.N, Worker: run.Worker, Complete: complete}
	deadline := time.Now().Add(wait)
	for {
		p := d.procOf(id)
		c.Running = p != nil && p.run.N == run.N
		if !c.Running {
			c.Usage, err = workers.ExitUsage(ctx, env.DB, id, run.N)
			if err != nil {
				return c, err
			}
		}
		st, statErr := os.Stat(run.Log)
		if statErr != nil {
			if os.IsNotExist(statErr) {
				return c, api.NotFound("%s 第 %d 轮日志文件缺失；终态超过14天的本机日志会清理，缺失不能证明已清理", id, run.N)
			}
			return c, statErr
		}
		c.Size = st.Size()
		var text string
		var next int64
		if complete {
			text, next, err = workers.ReadRawLog(run.Log, offset)
		} else {
			text, next, err = workers.ReadLog(run.Log, offset)
		}
		if os.IsNotExist(err) {
			return c, api.NotFound("%s 第 %d 轮日志文件缺失；终态超过14天的本机日志会清理，缺失本身不能证明已清理", id, run.N).WithNext("atrium task show " + id)
		}
		if err != nil {
			return c, err
		}
		if text != "" || !c.Running || time.Now().After(deadline) {
			c.Text, c.Offset, c.From = text, next, next-int64(len(text))
			return c, nil
		}
		select {
		case <-ctx.Done():
			return c, ctx.Err()
		case <-p.done:
		case <-time.After(300 * time.Millisecond):
		}
	}
}
