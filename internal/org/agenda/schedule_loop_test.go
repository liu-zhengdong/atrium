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
	if _, err := env.DB.Exec(`UPDATE schedules SET every_ms=-1 WHERE id=?`, bad.ID); err != nil {
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

func TestOnceDue(t *testing.T) {
	sh := time.FixedZone("CST", 8*3600)
	now := ms(time.Date(2026, 9, 30, 15, 0, 0, 0, sh))
	due := ms(time.Date(2026, 10, 8, 10, 0, 0, 0, sh))
	for _, c := range []struct {
		name string
		now  int64
		open string
		want Verdict
	}{
		{"没到点", due - minute, "", Verdict{Kind: "wait", Next: due}},
		{"刚到点", due, "", Verdict{Kind: "run"}},
		{"停机错过 3 天，补这一次", due + 3*day, "", Verdict{Kind: "run"}},
		{"手动生成的还没结束也照样到点生成", due, "t9", Verdict{Kind: "run"}},
	} {
		if got := Due(due, 0, nil, c.open, c.now, sh); got != c.want {
			t.Errorf("%s：%+v，应为 %+v", c.name, got, c.want)
		}
	}
	for _, c := range []struct {
		on, at string
		want   int64 // -1 拒绝
	}{
		{"2026-10-08", "10:00", due},
		{"2026-10-08", "", ms(time.Date(2026, 10, 8, 9, 0, 0, 0, sh))},
		{"2026-09-30", "15:30", now + 30*minute},
		{"2026-09-30", "15:00", -1}, // 就是现在，算过去
		{"2026-09-29", "", -1},
		{"2026-02-30", "", -1},
		{"2026-10-8", "", -1},
		{"10-08", "", -1},
		{"2026-10-08", "25:00", -1},
	} {
		got, err := ParseOn(c.on, c.at, now, sh)
		if (c.want < 0) != (err != nil) || (c.want >= 0 && got != c.want) {
			t.Errorf("ParseOn(%q, %q) = %v %v", c.on, c.at, time.UnixMilli(got).In(sh), err)
		}
	}
	if got := Cadence(Schedule{Once: true, NextAt: due}, sh); got != "一次 10-08 10:00" {
		t.Errorf("Cadence：%q", got)
	}
}

// 一次性定时：到点生成、生成后删掉、停机错过恢复后补、暂停范围内不动；建的时候拒绝不合法的组合。
func TestOnceTick(t *testing.T) {
	env, dept := setup(t)
	ctx := context.Background()
	loc := time.UTC
	start := ms(time.Date(2026, 9, 30, 8, 0, 0, 0, loc))
	var queued []string
	old := Enqueue
	t.Cleanup(func() { Enqueue = old })
	Enqueue = func(_ context.Context, _ *app.Env, task, _ string) error { queued = append(queued, task); return nil }

	for _, in := range []NewSchedule{
		{Every: "1d", On: "2026-10-08"},
		{On: "2026-09-29"},
		{On: "2026-10-08", Kind: "patrol"},
		{},
	} {
		in.Org, in.Title = dept, "x"
		if _, err := AddSchedule(ctx, env.DB, in, "u1", start, loc); code(err) != "usage" {
			t.Errorf("%+v 应拒绝：%v", in, err)
		}
	}
	x, err := AddSchedule(ctx, env.DB, NewSchedule{Org: dept, Title: "节后看一眼", On: "2026-10-08", At: "10:00"}, "u1", start, loc)
	due := ms(time.Date(2026, 10, 8, 10, 0, 0, 0, loc))
	if err != nil || !x.Once || x.NextAt != due || Cadence(x, loc) != "一次 10-08 10:00" {
		t.Fatalf("%+v %v", x, err)
	}
	if err := Tick(ctx, env, due-minute, loc); err != nil || len(queued) != 0 {
		t.Fatalf("没到点不该生成：%v %v", queued, err)
	}
	// 暂停范围内到点也不动。
	env.Pause.Set(ctx, dept, "u1")
	if err := Tick(ctx, env, due+day, loc); err != nil || len(queued) != 0 {
		t.Fatalf("暂停时不该生成：%v %v", queued, err)
	}
	env.Pause.Clear(ctx, dept)
	// 恢复后补这一次，生成后这条删掉，任务照常。
	if err := Tick(ctx, env, due+2*day, loc); err != nil || len(queued) != 1 {
		t.Fatalf("恢复后应补一次：%v %v", queued, err)
	}
	if _, err := GetSchedule(ctx, env.DB, x.ID); code(err) != "not_found" {
		t.Fatalf("生成后应删掉：%v", err)
	}
	task, err := ledger.Get(ctx, env.DB, queued[0])
	if err != nil || task.Title != "节后看一眼（10-10）" || !strings.Contains(task.Detail, "定在 10-08 10:00 的一次") {
		t.Fatalf("%+v %v", task, err)
	}
	if err := Tick(ctx, env, due+3*day, loc); err != nil || len(queued) != 1 {
		t.Fatalf("只生成一次：%v %v", queued, err)
	}
	// 手动 run 也是这一次：生成后删掉。
	y, err := AddSchedule(ctx, env.DB, NewSchedule{Org: dept, Title: "提前做", On: "2027-01-04"}, "u1", start, loc)
	if err != nil {
		t.Fatal(err)
	}
	if tk, err := RunNow(ctx, env, y.ID, loc); err != nil || tk.ID == "" {
		t.Fatalf("%+v %v", tk, err)
	}
	if _, err := GetSchedule(ctx, env.DB, y.ID); code(err) != "not_found" {
		t.Fatalf("手动生成后应删掉：%v", err)
	}
}
