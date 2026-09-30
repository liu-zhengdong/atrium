package workers

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestElapsed(t *testing.T) {
	for _, c := range []struct {
		start, end int64
		want       *int64
	}{
		{100, 200, ms(100)}, {100, 100, ms(0)}, {0, 200, nil}, {100, 0, nil}, {200, 100, nil},
	} {
		if got := elapsed(c.start, c.end); !reflect.DeepEqual(got, c.want) {
			t.Errorf("elapsed(%d, %d) = %v, want %v", c.start, c.end, got, c.want)
		}
	}
}

func ms(n int64) *int64 { return &n }

func TestMedian(t *testing.T) {
	for _, c := range []struct {
		in   []int64
		want *int64
	}{
		{nil, nil}, {[]int64{0}, ms(0)}, {[]int64{900, 100, 500}, ms(500)}, {[]int64{900, 100}, ms(500)}, {[]int64{2, 1}, ms(1)},
	} {
		before := append([]int64(nil), c.in...)
		if got := median(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("median(%v) = %v, want %v", c.in, got, c.want)
		}
		if !reflect.DeepEqual(before, c.in) {
			t.Fatal("改了输入")
		}
	}
}

func TestSettleDuration(t *testing.T) {
	event := func(kind string, at int64, body any) Event {
		raw, _ := json.Marshal(body)
		return Event{Kind: kind, At: at, Body: string(raw)}
	}
	launch := func(n int, at int64) Event { return event(RunKind, at, Run{N: n, Worker: "opencode+model", At: 1}) }
	evs := []Event{
		launch(1, 1000), event(ExitKind, 301000, Exit{N: 1, Outcome: OutOK}),
		event("exit_ok", 401000, map[string]string{"note": "收尾"}),
		event("bounce", 901000, map[string]string{"note": "交回"}),
		launch(2, 1000000), event("exit_fail", 1600000, map[string]string{"note": "watch"}),
		event("exit_fail", 1700000, map[string]string{"note": "重复"}),
		launch(3, 2000000), event(ExitKind, 2001000, Exit{N: 3, Outcome: OutSetup}),
		launch(4, 3000000),
	}
	got, err := Settle("t1", evs)
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range []*int64{ms(300000), ms(600000), ms(1000), nil} {
		if !reflect.DeepEqual(got[i].DurationMS, want) {
			t.Errorf("第 %d 次：%+v，应为 %v", i+1, got[i], want)
		}
	}
	if got[0].Outcome != OutBounce || got[1].Reason != "watch" {
		t.Fatalf("结果或时间被后续经历覆盖：%+v", got)
	}
	if _, err := Settle("t1", []Event{{Kind: RunKind, Body: "{"}}); err == nil {
		t.Fatal("损坏的经历必须报错")
	}
}

func TestCountDuration(t *testing.T) {
	ls := []Attempt{
		{Outcome: OutOK, DurationMS: ms(540000)}, {Outcome: OutBounce, DurationMS: ms(660000)},
		{Outcome: OutSetup, DurationMS: ms(1000)}, {Outcome: OutQuota, DurationMS: ms(2000)},
		{Outcome: OutFail, DurationMS: ms(3000000)}, {Outcome: OutOK},
	}
	s := Count(ls)
	if !reflect.DeepEqual(s.MedianMS, ms(600000)) || !reflect.DeepEqual(s.MaxMS, ms(3000000)) {
		t.Fatalf("%+v", s)
	}
	if s.Timing() != "用时中位 10 分 · 最长 50 分" {
		t.Fatal(s.Timing())
	}
	failed := Count(ls[2:5])
	if failed.Timing() != "用时中位 — · 最长 50 分" {
		t.Fatal(failed.Timing())
	}
	if got := (Stat{}).Timing(); got != "用时中位 — · 最长 —" {
		t.Fatal(got)
	}
	if DurationText(ms(2000)) != "2 秒" || DurationText(ms(0)) != "0 秒" {
		t.Fatal("秒级或零用时展示错误")
	}
}
