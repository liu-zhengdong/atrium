package agenda

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
)

func TestTickIsolatesBadSchedule(t *testing.T) {
	env, dept := setup(t)
	ctx := context.Background()
	start := int64(1000)
	bad, err := AddSchedule(ctx, env.DB, NewSchedule{Org: dept, Title: "bad", Every: "1h"}, "u1", start, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	good, err := AddSchedule(ctx, env.DB, NewSchedule{Org: dept, Title: "good", Every: "1h"}, "u1", start, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.DB.Exec(`UPDATE schedules SET every_ms=0 WHERE id=?`, bad.ID); err != nil {
		t.Fatal(err)
	}
	calls := 0
	old := Enqueue
	t.Cleanup(func() { Enqueue = old })
	Enqueue = func(context.Context, *app.Env, string, string) error { calls++; return nil }
	now := start + hour
	if err := Tick(ctx, env, now, time.UTC); err != nil {
		t.Fatal(err)
	}
	if err := Tick(ctx, env, now, time.UTC); err != nil {
		t.Fatal(err)
	}
	x, err := GetSchedule(ctx, env.DB, bad.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(x.LastNote, scheduleLoopError) || calls != 1 {
		t.Fatalf("bad=%+v calls=%d", x, calls)
	}
	y, err := GetSchedule(ctx, env.DB, good.ID)
	if err != nil || y.LastTask == "" {
		t.Fatalf("good=%+v err=%v", y, err)
	}
	var n int
	if err := env.DB.QueryRow(`SELECT count(*) FROM events WHERE kind='schedule.failed'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("notifications=%d", n)
	}
	if _, err := env.DB.Exec(`UPDATE schedules SET every_ms=3600000 WHERE id=?`, bad.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := RunNow(ctx, env, bad.ID, time.UTC); err != nil {
		t.Fatal(err)
	}
	x, err = GetSchedule(ctx, env.DB, bad.ID)
	if err != nil || strings.HasPrefix(x.LastNote, scheduleLoopError) {
		t.Fatalf("人工重试未恢复：%+v %v", x, err)
	}
}

func TestTickEnqueueErrorBlocksOnlyRound(t *testing.T) {
	env, dept := setup(t)
	ctx := context.Background()
	start := int64(1000)
	for _, title := range []string{"bad", "good"} {
		if _, err := AddSchedule(ctx, env.DB, NewSchedule{Org: dept, Title: title, Every: "1h"}, "u1", start, time.UTC); err != nil {
			t.Fatal(err)
		}
	}
	calls := 0
	old := Enqueue
	t.Cleanup(func() { Enqueue = old })
	Enqueue = func(context.Context, *app.Env, string, string) error {
		calls++
		if calls == 1 {
			return errors.New("bad input")
		}
		return nil
	}
	if err := Tick(ctx, env, start+hour, time.UTC); err != nil {
		t.Fatal(err)
	}
	x, _ := GetSchedule(ctx, env.DB, "s1")
	task, err := ledger.Get(ctx, env.DB, x.LastTask)
	if err != nil || task.Status != ledger.Blocked || calls != 2 {
		t.Fatalf("task=%+v err=%v calls=%d", task, err, calls)
	}
}
