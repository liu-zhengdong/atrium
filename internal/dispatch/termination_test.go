package dispatch

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/watch"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 真正拉起睡眠执行者，巡检只变更账本，reap 负责终止；旧轮次迟到不能结束替代进程。
func TestWatchTerminationOwnership(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	// 启动超时要求没有输出；共享 kimi 假执行者会先输出 started，
	// 较快机器上 observe 会把它算成进展，切换为 20 分钟超时。
	fake, err := exec.LookPath("kimi")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	env.Log = slog.New(slog.NewTextHandler(&logs, nil))
	hook(env)
	tk, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "超时终止"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "kimi"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	old := d.procOf(tk.ID)
	if old == nil {
		t.Fatal("未拉起执行者")
	}
	if _, err := env.DB.ExecContext(ctx, `UPDATE task_events SET body=json_set(body,'$.at',?) WHERE task=? AND kind='proc'`, store.Now()-181000, tk.ID); err != nil {
		t.Fatal(err)
	}
	if err := watch.Tick(ctx, env); err != nil {
		t.Fatal(err)
	}
	state, err := ledger.Get(ctx, env.DB, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != ledger.Queued {
		t.Fatalf("巡检未触发超时换人：status=%s stage=%s", state.Status, state.Stage)
	}
	if !platform.Alive(old.run.PID) {
		t.Fatal("watch 重复终止了执行者")
	}
	if err := d.reap(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-old.done:
	case <-time.After(5 * time.Second):
		t.Fatal("reap 未结束本轮")
	}
	if platform.Alive(old.run.PID) {
		t.Fatal("旧执行者仍存活")
	}
	// 原轮次收尾后，真实换人队列拉起假 claude（等标准输入关闭才退出）。
	d.wg.Wait()
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	replacement := d.procOf(tk.ID)
	if replacement == nil || replacement == old {
		t.Fatal("未拉起替代执行者")
	}
	d.kill(ctx, old)
	if !platform.Alive(replacement.run.PID) {
		t.Fatal("迟到终止误杀替代执行者")
	}
	// 模拟旧 PID 被复用：closed done 必须先于 PID/远程任务号使用。
	stale := &proc{task: tk.ID, run: workers.Run{PID: replacement.run.PID}, done: old.done}
	d.kill(ctx, stale)
	select {
	case <-replacement.done:
		t.Fatal("已退出轮次仍使用复用 PID，替代执行者已退出")
	case <-time.After(200 * time.Millisecond):
	}
	if !platform.Alive(replacement.run.PID) {
		t.Fatal("已退出轮次仍使用复用 PID")
	}
	if strings.Contains(logs.String(), "结束执行者失败") {
		t.Fatalf("错误的终止记录：%s", logs.String())
	}
	t.Logf("旧轮次 pid=%d 已退出，替代 pid=%d 存活；重复与复用 PID 均未终止替代进程", old.run.PID, replacement.run.PID)
}

func TestTerminationFailureVisible(t *testing.T) {
	env, d := setup(t)
	var logs bytes.Buffer
	env.Log = slog.New(slog.NewTextHandler(&logs, nil))
	// 故意坏输入由 platform 拒绝，不向任何真实进程发送信号。
	d.kill(context.Background(), &proc{task: "bad", run: workers.Run{PID: -1}, done: make(chan struct{})})
	if !strings.Contains(logs.String(), "结束执行者失败") || !strings.Contains(logs.String(), "pid=-1") {
		t.Fatalf("真实终止错误被吞掉：%s", logs.String())
	}
	t.Log(logs.String())
}
