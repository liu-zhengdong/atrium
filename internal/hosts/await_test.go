package hosts

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestAgain(t *testing.T) {
	cases := []struct {
		kind           string
		taken, polling bool
		want           bool
	}{
		{"launch", false, false, true},
		{"query", false, false, true},
		{"reclaim", false, false, true},
		{"launch", false, true, false},
		{"query", false, true, false},
		{"launch", true, false, false},
		{"reclaim", true, false, false},
		{"query", true, false, true},
		{"launch", true, true, false},
		{"query", true, true, false},
	}
	for _, c := range cases {
		if got := again(c.kind, c.taken, c.polling); got != c.want {
			t.Errorf("again(%s, taken=%v, polling=%v)=%v，期望 %v", c.kind, c.taken, c.polling, got, c.want)
		}
	}
}

func useShortAway(t *testing.T) {
	t.Helper()
	oldG, oldT := awayGrace, awayTick
	awayGrace, awayTick = 60*time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() { awayGrace, awayTick = oldG, oldT })
}

func TestAwayBeforeTake(t *testing.T) {
	g := newRig(t)
	cfg := g.join(t.TempDir())
	g.task("t1")
	useShortAway(t)
	log := filepath.Join(t.TempDir(), "run.log")
	start := time.Now()
	_, _, _, err := Launch(context.Background(), g.env, cfg.Host, Assignment{Task: "t1", Log: log})
	if !app.IsNotNow(err) {
		t.Fatalf("拉起应下一轮再试：%v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("没在领指令不该干等：%s", time.Since(start))
	}
	if _, err := getRun(context.Background(), g.env.DB, "t1"); !store.IsNotFound(err) {
		t.Fatalf("还没下发不应留下运行：%v", err)
	}
	if _, err := Ask(context.Background(), cfg.Host, Query{Dir: t.TempDir(), File: "x"}); !app.IsNotNow(err) {
		t.Fatalf("查询应下一轮再试：%v", err)
	}
	if q := theHub.queue[cfg.Host]; len(q) != 0 {
		t.Fatalf("指令还在队列：%+v", q)
	}
	// 下一轮：有人领并回执，拉起成功。
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := make(chan []Command, 1)
	go func() { got <- theHub.take(ctx, cfg.Host, 2*time.Second) }()
	waitPolling(ctx, cfg.Host)
	done := make(chan error, 1)
	go func() {
		_, _, _, err := Launch(context.Background(), g.env, cfg.Host, Assignment{Task: "t1", Log: log})
		done <- err
	}()
	cmds := <-got
	if len(cmds) != 1 || cmds[0].Kind != "launch" {
		t.Fatalf("指令：%+v", cmds)
	}
	theHub.ack(Ack{ID: cmds[0].ID, OK: true, PID: 7, Dir: filepath.Join(t.TempDir(), "work")})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	row, err := getRun(context.Background(), g.env.DB, "t1")
	if err != nil || row.Exited || row.PID != 7 || row.Run != 1 {
		t.Fatalf("拉起后的运行：%+v %v", row, err)
	}
}

func TestQueryAwayAfterTake(t *testing.T) {
	g := newRig(t)
	cfg := g.join(t.TempDir())
	useShortAway(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := make(chan []Command, 1)
	go func() { got <- theHub.take(ctx, cfg.Host, 2*time.Second) }()
	if err := waitPolling(ctx, cfg.Host); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	errc := make(chan error, 1)
	go func() {
		_, err := Ask(context.Background(), cfg.Host, Query{Dir: t.TempDir(), File: "x"})
		errc <- err
	}()
	cmds := <-got
	if len(cmds) != 1 {
		t.Fatalf("指令：%+v", cmds)
	}
	// 领走后不再轮询、也不回执。
	err := <-errc
	if !app.IsNotNow(err) {
		t.Fatalf("查询领走后机器走开应下一轮再试：%v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("不该等到查询时限：%s", time.Since(start))
	}
	if q := theHub.queue[cfg.Host]; len(q) != 0 {
		t.Fatalf("指令还在：%+v", q)
	}
}

func TestLaunchTakenWithoutAckFails(t *testing.T) {
	g := newRig(t)
	cfg := g.join(t.TempDir())
	g.task("t1")
	old := ackWait
	ackWait = 200 * time.Millisecond
	t.Cleanup(func() { ackWait = old })
	useShortAway(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		for ctx.Err() == nil {
			theHub.take(ctx, cfg.Host, time.Second) // 领走但不回执，并继续轮询
		}
	}()
	if err := waitPolling(ctx, cfg.Host); err != nil {
		t.Fatal(err)
	}
	_, _, _, err := Launch(context.Background(), g.env, cfg.Host, Assignment{Task: "t1", Log: filepath.Join(t.TempDir(), "run.log")})
	if err == nil || app.IsNotNow(err) {
		t.Fatalf("一直在领却不回执拉起应失败：%v", err)
	}
	row, gerr := getRun(context.Background(), g.env.DB, "t1")
	if gerr != nil || !row.Exited || !row.Exit.Lost {
		t.Fatalf("应按退出不明收尾：%+v %v", row, gerr)
	}
}
