package ledger

import (
	"reflect"
	"testing"
)

func TestTransition(t *testing.T) {
	st := func(s Status, g Stage) State { return State{s, g} }
	ok := []struct {
		name string
		from State
		ev   Event
		want State
	}{
		{"派活", st(Todo, ""), Event{Kind: Enqueue}, st(Queued, "")},
		{"失败后重派", st(Failed, ""), Event{Kind: Enqueue}, st(Queued, "")},
		{"受阻后重派清阶段", st(Blocked, StageMerge), Event{Kind: Enqueue}, st(Queued, "")},
		{"拉起", st(Queued, ""), Event{Kind: Start}, st(Running, "")},
		{"交付进关卡", st(Running, ""), Event{Kind: ExitOK}, st(Running, StageGate)},
		{"执行者失败", st(Running, ""), Event{Kind: ExitFail}, st(Failed, "")},
		{"关卡过进合入队列", st(Running, StageGate), Event{Kind: GatePass}, st(Running, StageMerge)},
		{"关卡过先审阅", st(Running, StageGate), Event{Kind: GatePass, NeedReview: true}, st(Running, StageReview)},
		{"关卡过无 PR 直接完成", st(Running, StageGate), Event{Kind: GatePass, NoMerge: true}, st(Done, StageGate)},
		{"审阅过", st(Running, StageReview), Event{Kind: ReviewPass}, st(Running, StageMerge)},
		{"第一次交回", st(Running, StageGate), Event{Kind: Bounce, Bounces: 0}, st(Queued, "")},
		{"第二次交回", st(Running, StageMerge), Event{Kind: Bounce, Bounces: 1}, st(Queued, "")},
		{"交回用尽转受阻", st(Running, StageReview), Event{Kind: Bounce, Bounces: 2}, st(Blocked, StageReview)},
		{"合入即完成", st(Running, StageMerge), Event{Kind: Merged}, st(Done, StageMerged)},
		{"合入等发版", st(Running, StageMerge), Event{Kind: Merged, NeedRelease: true}, st(Running, StageMerged)},
		{"上线", st(Running, StageMerged), Event{Kind: Released}, st(Done, StageReleased)},
		{"受阻", st(Running, StageGate), Event{Kind: Block}, st(Blocked, StageGate)},
		{"取消在队列的", st(Queued, ""), Event{Kind: Cancel}, st(Cancelled, "")},
		{"人工改回 todo 清阶段", st(Blocked, StageReview), Event{Kind: Set, To: Todo}, st(Todo, "")},
		{"人工完成", st(Running, StageMerge), Event{Kind: Set, To: Done}, st(Done, StageMerge)},
	}
	for _, c := range ok {
		got, err := Transition(c.from, c.ev)
		if err != nil || got != c.want {
			t.Errorf("%s: got %+v, %v; want %+v", c.name, got, err, c.want)
		}
	}
	bad := []struct {
		name string
		from State
		ev   Event
	}{
		{"在跑的不能再派", st(Running, ""), Event{Kind: Enqueue}},
		{"完成的不能再派", st(Done, ""), Event{Kind: Enqueue}},
		{"todo 不能直接拉起", st(Todo, ""), Event{Kind: Start}},
		{"交付中不接执行者退出", st(Running, StageGate), Event{Kind: ExitOK}},
		{"没进关卡不能过关卡", st(Running, ""), Event{Kind: GatePass}},
		{"不在审阅不能审阅过", st(Running, StageGate), Event{Kind: ReviewPass}},
		{"在跑时无可交回", st(Running, ""), Event{Kind: Bounce}},
		{"不在队列不能合入", st(Running, StageReview), Event{Kind: Merged}},
		{"没合入不能上线", st(Running, StageMerge), Event{Kind: Released}},
		{"完成的不能受阻", st(Done, ""), Event{Kind: Block}},
		{"完成的不能取消", st(Done, ""), Event{Kind: Cancel}},
		{"取消的不能再取消", st(Cancelled, ""), Event{Kind: Cancel}},
		{"人工不能进 running", st(Todo, ""), Event{Kind: Set, To: Running}},
		{"人工不能进 queued", st(Todo, ""), Event{Kind: Set, To: Queued}},
		{"未知状态", st(Todo, ""), Event{Kind: Set, To: "wat"}},
		{"未知事件", st(Todo, ""), Event{Kind: "wat"}},
	}
	for _, c := range bad {
		if got, err := Transition(c.from, c.ev); err == nil || got != c.from {
			t.Errorf("%s: 应拒绝，got %+v %v", c.name, got, err)
		}
	}
}

func TestReady(t *testing.T) {
	cases := []struct {
		name    string
		s       Status
		deps    []DepState
		ready   bool
		waiting []string
	}{
		{"无依赖", Todo, nil, true, nil},
		{"依赖都完成", Todo, []DepState{{"t1", Done}, {"t2", Done}}, true, nil},
		{"有依赖没完成", Todo, []DepState{{"t1", Done}, {"t2", Running}}, false, []string{"t2"}},
		{"依赖被取消不算完成", Todo, []DepState{{"t1", Cancelled}}, false, []string{"t1"}},
		{"自己不是 todo", Blocked, nil, false, nil},
	}
	for _, c := range cases {
		r, w := Ready(c.s, c.deps)
		if r != c.ready || !reflect.DeepEqual(w, c.waiting) {
			t.Errorf("%s: got %v %v", c.name, r, w)
		}
	}
}

func TestRollup(t *testing.T) {
	cases := []struct {
		in   []Status
		want Status
		text string
	}{
		{nil, "", ""},
		{[]Status{Done, Cancelled}, Done, "1/2 完成，1 取消"},
		{[]Status{Done, Running, Blocked}, Running, "1/3 完成，1 在做，1 受阻"},
		{[]Status{Todo, Failed}, Blocked, "0/2 完成，1 失败"},
		{[]Status{Todo, Done}, Todo, "1/2 完成"},
	}
	for _, c := range cases {
		s := Summarize(c.in)
		if s.Rollup() != c.want || s.String() != c.text {
			t.Errorf("%v: got %q %q", c.in, s.Rollup(), s.String())
		}
	}
}

func TestPlan(t *testing.T) {
	in := []PlanInput{
		{ID: "t2", Status: Todo},
		{ID: "t3", Status: Todo, Deps: []string{"t2"}},
		{ID: "t4", Status: Todo, Deps: []string{"t3", "t2"}},
		{ID: "t5", Status: Done},
		{ID: "t6", Status: Todo, Deps: []string{"t5", "t9"}}, // t9 在集合外、已完成
		{ID: "t7", Status: Todo, Deps: []string{"t8"}},       // t8 在集合外、没完成
	}
	rows := Plan(in, map[string]Status{"t9": Done, "t8": Running})
	type r struct {
		id    string
		step  int
		ready bool
		wait  []string
	}
	want := []r{{"t5", 0, false, nil}, {"t2", 1, true, nil}, {"t6", 1, true, nil}, {"t7", 1, false, []string{"t8"}},
		{"t3", 2, false, []string{"t2"}}, {"t4", 3, false, []string{"t3", "t2"}}}
	if len(rows) != len(want) {
		t.Fatalf("got %d rows", len(rows))
	}
	for i, w := range want {
		g := rows[i]
		if g.ID != w.id || g.Step != w.step || g.Ready != w.ready || !reflect.DeepEqual(g.WaitingOn, w.wait) {
			t.Errorf("row %d: got %+v want %+v", i, g, w)
		}
	}
}

func TestFindCycle(t *testing.T) {
	if c := FindCycle(map[string][]string{"a": {"b"}, "b": {"c"}}); c != nil {
		t.Errorf("无环 got %v", c)
	}
	c := FindCycle(map[string][]string{"a": {"b"}, "b": {"c"}, "c": {"a"}})
	if !reflect.DeepEqual(c, []string{"a", "b", "c", "a"}) {
		t.Errorf("got %v", c)
	}
	if c := FindCycle(map[string][]string{"x": {"x"}}); !reflect.DeepEqual(c, []string{"x", "x"}) {
		t.Errorf("自环 got %v", c)
	}
}

func TestPriorityRank(t *testing.T) {
	if !(Urgent.Rank() < Fix.Rank() && Fix.Rank() < Normal.Rank() && Normal.Rank() < Idle.Rank()) {
		t.Error("顺序不对")
	}
	if Priority("high").Rank() != -1 {
		t.Error("非法优先级应为 -1")
	}
}

func TestBuildTree(t *testing.T) {
	root := BuildTree([]Task{
		{ID: "t1", Status: Running}, {ID: "t2", Parent: "t1", Status: Done},
		{ID: "t3", Parent: "t1", Status: Running}, {ID: "t4", Parent: "t3", Status: Blocked},
	})
	if len(root.Children) != 2 || root.Summary.Total != 3 || root.Summary.Rollup() != Running {
		t.Fatalf("root %+v", root)
	}
	if t3 := root.Children[1]; t3.Summary.Total != 1 || t3.Children[0].ID != "t4" {
		t.Fatalf("t3 %+v", t3)
	}
	if root.Children[0].Summary != nil {
		t.Error("叶子不该有汇总")
	}
}
