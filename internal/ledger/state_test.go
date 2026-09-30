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
		{"分派任务", st(Todo, ""), Event{Kind: Enqueue}, st(Queued, "")},
		{"失败后重派", st(Failed, ""), Event{Kind: Enqueue}, st(Queued, "")},
		{"受阻后重派清阶段", st(Blocked, StageMerge), Event{Kind: Enqueue}, st(Queued, "")},
		{"拉起", st(Queued, ""), Event{Kind: Start}, st(Running, "")},
		{"交付进交付检查", st(Running, ""), Event{Kind: ExitOK}, st(Running, StageGate)},
		{"执行者失败", st(Running, ""), Event{Kind: ExitFail}, st(Failed, "")},
		{"交付检查通过后进入应用", st(Running, StageGate), Event{Kind: GatePass, Land: StageMerge}, st(Running, StageMerge)},
		{"交付检查通过后先审阅", st(Running, StageGate), Event{Kind: GatePass, NeedReview: true}, st(Running, StageReview)},
		{"交付检查过没有应用步骤直接完成", st(Running, StageGate), Event{Kind: GatePass}, st(Done, StageGate)},
		{"交付检查过等验收", st(Running, StageGate), Event{Kind: GatePass, AcceptBy: "user", Land: StageMerge}, st(Running, StageAccept)},
		{"交付检查通过后先审阅再验收", st(Running, StageGate), Event{Kind: GatePass, NeedReview: true, AcceptBy: "user"}, st(Running, StageReview)},
		{"审阅过", st(Running, StageReview), Event{Kind: ReviewPass, Land: StageMerge}, st(Running, StageMerge)},
		{"审阅过等验收", st(Running, StageReview), Event{Kind: ReviewPass, AcceptBy: "leader"}, st(Running, StageAccept)},
		{"验收过进应用", st(Running, StageAccept), Event{Kind: Accept, Land: StageMerge}, st(Running, StageMerge)},
		{"验收过当场完成", st(Running, StageAccept), Event{Kind: Accept}, st(Done, StageAccept)},
		{"验收打回", st(Running, StageAccept), Event{Kind: Bounce, Bounces: 1}, st(Queued, "")},
		{"验收打回用尽转受阻", st(Running, StageAccept), Event{Kind: Bounce, Bounces: 2}, st(Blocked, StageAccept)},
		{"第一次交回", st(Running, StageGate), Event{Kind: Bounce, Bounces: 0}, st(Queued, "")},
		{"第二次交回", st(Running, StageMerge), Event{Kind: Bounce, Bounces: 1}, st(Queued, "")},
		{"交回用尽转受阻", st(Running, StageReview), Event{Kind: Bounce, Bounces: 2}, st(Blocked, StageReview)},
		{"应用一步即完成", st(Running, StageMerge), Event{Kind: Land, Land: StageMerged, Final: true}, st(Done, StageMerged)},
		{"应用一步还没完", st(Running, StageMerge), Event{Kind: Land, Land: StageMerged}, st(Running, StageMerged)},
		{"应用最后一步", st(Running, StageMerged), Event{Kind: Land, Land: StageReleased, Final: true}, st(Done, StageReleased)},
		{"受阻", st(Running, StageGate), Event{Kind: Block}, st(Blocked, StageGate)},
		{"审阅受阻后重跑审阅过", st(Blocked, StageReview), Event{Kind: ReviewPass, Land: StageMerge}, st(Running, StageMerge)},
		{"审阅受阻后重跑打回", st(Blocked, StageReview), Event{Kind: Bounce, Bounces: 1}, st(Queued, "")},
		{"审阅受阻后重跑打回用尽仍受阻", st(Blocked, StageReview), Event{Kind: Bounce, Bounces: 2}, st(Blocked, StageReview)},
		{"审阅受阻后重跑没结论再受阻", st(Blocked, StageReview), Event{Kind: Block}, st(Blocked, StageReview)},
		{"取消在队列的", st(Queued, ""), Event{Kind: Cancel}, st(Cancelled, "")},
		{"人工改回 todo 清阶段", st(Blocked, StageReview), Event{Kind: Set, To: Todo}, st(Todo, "")},
		{"人工完成", st(Running, StageMerge), Event{Kind: Set, To: Done}, st(Done, StageMerge)},
		{"登记亲手做的 PR", st(Todo, ""), Event{Kind: Deliver, Land: StageMerge}, st(Running, StageMerge)},
		{"放行受阻的交付", st(Blocked, StageMerge), Event{Kind: Deliver, Land: StageMerge}, st(Running, StageMerge)},
		{"放行但要等验收", st(Blocked, StageAccept), Event{Kind: Deliver, AcceptBy: "user", Land: StageMerge}, st(Running, StageAccept)},
		{"草稿直接派", st(Draft, ""), Event{Kind: Enqueue}, st(Queued, "")},
		{"草稿转待派", st(Draft, ""), Event{Kind: Set, To: Todo}, st(Todo, "")},
		{"待派退回草稿", st(Todo, ""), Event{Kind: Set, To: Draft}, st(Draft, "")},
		{"受阻退回草稿清阶段", st(Blocked, StageGate), Event{Kind: Set, To: Draft}, st(Draft, "")},
		{"取消草稿", st(Draft, ""), Event{Kind: Cancel}, st(Cancelled, "")},
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
		{"没进交付检查不能过交付检查", st(Running, ""), Event{Kind: GatePass}},
		{"不在审阅不能审阅过", st(Running, StageGate), Event{Kind: ReviewPass}},
		{"在跑时无可交回", st(Running, ""), Event{Kind: Bounce}},
		{"不在应用不能推进应用", st(Running, StageReview), Event{Kind: Land, Land: StageMerged}},
		{"等验收时不能推进应用", st(Running, StageAccept), Event{Kind: Land, Land: StageMerged}},
		{"应用步骤不能是核心阶段", st(Running, StageMerge), Event{Kind: Land, Land: StageAccept}},
		{"交付检查通过后的应用步骤不能是核心阶段", st(Running, StageGate), Event{Kind: GatePass, Land: StageReview}},
		{"不在等验收不能验收", st(Running, StageGate), Event{Kind: Accept}},
		{"放进应用要给步骤", st(Todo, ""), Event{Kind: Deliver}},
		{"完成的不能受阻", st(Done, ""), Event{Kind: Block}},
		{"受阻的不能再受阻", st(Blocked, StageGate), Event{Kind: Block}},
		{"应用受阻不能审阅过", st(Blocked, StageMerge), Event{Kind: ReviewPass}},
		{"应用受阻无可交回", st(Blocked, StageMerge), Event{Kind: Bounce}},
		{"完成的不能取消", st(Done, ""), Event{Kind: Cancel}},
		{"取消的不能再取消", st(Cancelled, ""), Event{Kind: Cancel}},
		{"人工不能进 running", st(Todo, ""), Event{Kind: Set, To: Running}},
		{"人工不能进 queued", st(Todo, ""), Event{Kind: Set, To: Queued}},
		{"未知状态", st(Todo, ""), Event{Kind: Set, To: "wat"}},
		{"未知事件", st(Todo, ""), Event{Kind: "wat"}},
		{"在跑的执行者不能放进合入队列", st(Running, ""), Event{Kind: Deliver, Land: StageMerge}},
		{"完成的不能放进合入队列", st(Done, StageMerged), Event{Kind: Deliver, Land: StageMerge}},
		{"在跑的不能退回草稿", st(Running, ""), Event{Kind: Set, To: Draft}},
		{"完成的不能退回草稿", st(Done, ""), Event{Kind: Set, To: Draft}},
		{"草稿不能标受阻", st(Draft, ""), Event{Kind: Block}},
		{"草稿不能放进合入队列", st(Draft, ""), Event{Kind: Deliver, Land: StageMerge}},
	}
	for _, c := range bad {
		if got, err := Transition(c.from, c.ev); err == nil || got != c.from {
			t.Errorf("%s: 应拒绝，got %+v %v", c.name, got, err)
		}
	}
}

func TestDepGate(t *testing.T) {
	cases := []struct {
		name    string
		deps    []DepState
		waiting []string
		broken  []DepState
		text    string
	}{
		{"无依赖", nil, nil, nil, ""},
		{"依赖都完成", []DepState{{"t1", Done}, {"t2", Done}}, nil, nil, ""},
		{"有在跑的", []DepState{{"t1", Done}, {"t2", Running}}, []string{"t2"}, nil, ""},
		{"待派、排队、受阻、草稿都接着等", []DepState{{"t1", Todo}, {"t2", Queued}, {"t3", Blocked}, {"t4", Draft}},
			[]string{"t1", "t2", "t3", "t4"}, nil, ""},
		{"取消了等不到", []DepState{{"t449", Cancelled}, {"t456", Done}}, nil, []DepState{{"t449", Cancelled}}, "t449 已取消"},
		{"失败了等不到", []DepState{{"t1", Failed}}, nil, []DepState{{"t1", Failed}}, "t1 失败了"},
		{"完成、在做、取消、失败混合", []DepState{{"t1", Done}, {"t2", Running}, {"t3", Cancelled}, {"t4", Failed}, {"t5", Todo}},
			[]string{"t2", "t5"}, []DepState{{"t3", Cancelled}, {"t4", Failed}}, "t3 已取消、t4 失败了"},
	}
	for _, c := range cases {
		w, b := DepGate(c.deps)
		if !reflect.DeepEqual(w, c.waiting) || !reflect.DeepEqual(b, c.broken) || BrokenText(b) != c.text {
			t.Errorf("%s: waiting=%v broken=%v text=%q", c.name, w, b, BrokenText(b))
		}
	}
}

func TestRollup(t *testing.T) {
	cases := []struct {
		in   []Status
		want Status
		text string
		open int
	}{
		{nil, "", "", 0},
		{[]Status{Done, Cancelled}, Done, "1/2 完成，1 取消", 0},
		{[]Status{Done, Running, Blocked}, Running, "1/3 完成，1 在做，1 受阻", 2},
		{[]Status{Todo, Failed}, Blocked, "0/2 完成，1 失败", 1},
		{[]Status{Todo, Done}, Todo, "1/2 完成", 1},
	}
	for _, c := range cases {
		s := Summarize(c.in)
		if s.Rollup() != c.want || s.String() != c.text || s.Open() != c.open {
			t.Errorf("%v: got %q %q %d", c.in, s.Rollup(), s.String(), s.Open())
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
	}, nil)
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

// 树里每件标出能派还是在等谁：依赖可在树外；有子任务的不派它自己；只有 todo、排队中的标在等谁。
func TestBuildTreeReady(t *testing.T) {
	root := BuildTree([]Task{
		{ID: "t1", Status: Todo},
		{ID: "t2", Parent: "t1", Status: Todo},
		{ID: "t3", Parent: "t1", Status: Todo},
		{ID: "t4", Parent: "t1", Status: Todo},
		{ID: "t5", Parent: "t1", Status: Queued},
		{ID: "t6", Parent: "t1", Status: Blocked},
		{ID: "t7", Parent: "t2", Status: Draft},
		{ID: "t10", Parent: "t1", Status: Todo},
	}, map[string][]DepState{
		"t10": {{ID: "t11", Status: Cancelled}, {ID: "t8", Status: Running}}, // 取消的等不到，不算在等
		"t3":  {{ID: "t2", Status: Todo}},
		"t4":  {{ID: "t9", Status: Done}},    // 树外、已完成
		"t5":  {{ID: "t8", Status: Running}}, // 树外、没完成
		"t6":  {{ID: "t2", Status: Todo}},
	})
	type r struct {
		ready  bool
		wait   []string
		broken []DepState
	}
	want := map[string]r{"t1": {}, "t2": {}, "t3": {false, []string{"t2"}, nil}, "t4": {true, nil, nil},
		"t5": {false, []string{"t8"}, nil}, "t6": {}, "t7": {}, "t10": {false, []string{"t8"}, []DepState{{"t11", Cancelled}}}}
	var walk func(n *TreeNode)
	walk = func(n *TreeNode) {
		if w := want[n.ID]; n.Ready != w.ready || !reflect.DeepEqual(n.WaitingOn, w.wait) || !reflect.DeepEqual(n.Broken, w.broken) {
			t.Errorf("%s: ready=%v waiting=%v broken=%v，want %+v", n.ID, n.Ready, n.WaitingOn, n.Broken, w)
		}
		delete(want, n.ID)
		for _, c := range n.Children {
			walk(c)
		}
	}
	walk(root)
	if len(want) != 0 {
		t.Errorf("没走到：%v", want)
	}
}
