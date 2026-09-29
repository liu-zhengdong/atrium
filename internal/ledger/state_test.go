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
		{"关卡过进落地", st(Running, StageGate), Event{Kind: GatePass, Land: StageMerge}, st(Running, StageMerge)},
		{"关卡过先审阅", st(Running, StageGate), Event{Kind: GatePass, NeedReview: true}, st(Running, StageReview)},
		{"关卡过没有落地步骤直接完成", st(Running, StageGate), Event{Kind: GatePass}, st(Done, StageGate)},
		{"关卡过等验收", st(Running, StageGate), Event{Kind: GatePass, AcceptBy: "user", Land: StageMerge}, st(Running, StageAccept)},
		{"关卡过先审阅再验收", st(Running, StageGate), Event{Kind: GatePass, NeedReview: true, AcceptBy: "user"}, st(Running, StageReview)},
		{"审阅过", st(Running, StageReview), Event{Kind: ReviewPass, Land: StageMerge}, st(Running, StageMerge)},
		{"审阅过等验收", st(Running, StageReview), Event{Kind: ReviewPass, AcceptBy: "leader"}, st(Running, StageAccept)},
		{"验收过进落地", st(Running, StageAccept), Event{Kind: Accept, Land: StageMerge}, st(Running, StageMerge)},
		{"验收过当场完成", st(Running, StageAccept), Event{Kind: Accept}, st(Done, StageAccept)},
		{"验收打回", st(Running, StageAccept), Event{Kind: Bounce, Bounces: 1}, st(Queued, "")},
		{"验收打回用尽转受阻", st(Running, StageAccept), Event{Kind: Bounce, Bounces: 2}, st(Blocked, StageAccept)},
		{"第一次交回", st(Running, StageGate), Event{Kind: Bounce, Bounces: 0}, st(Queued, "")},
		{"第二次交回", st(Running, StageMerge), Event{Kind: Bounce, Bounces: 1}, st(Queued, "")},
		{"交回用尽转受阻", st(Running, StageReview), Event{Kind: Bounce, Bounces: 2}, st(Blocked, StageReview)},
		{"落地一步即完成", st(Running, StageMerge), Event{Kind: Land, Land: StageMerged, Final: true}, st(Done, StageMerged)},
		{"落地一步还没完", st(Running, StageMerge), Event{Kind: Land, Land: StageMerged}, st(Running, StageMerged)},
		{"落地最后一步", st(Running, StageMerged), Event{Kind: Land, Land: StageReleased, Final: true}, st(Done, StageReleased)},
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
		{"没进关卡不能过关卡", st(Running, ""), Event{Kind: GatePass}},
		{"不在审阅不能审阅过", st(Running, StageGate), Event{Kind: ReviewPass}},
		{"在跑时无可交回", st(Running, ""), Event{Kind: Bounce}},
		{"不在落地不能推进落地", st(Running, StageReview), Event{Kind: Land, Land: StageMerged}},
		{"等验收时不能推进落地", st(Running, StageAccept), Event{Kind: Land, Land: StageMerged}},
		{"落地步骤不能是核心阶段", st(Running, StageMerge), Event{Kind: Land, Land: StageAccept}},
		{"关卡过的落地步骤不能是核心阶段", st(Running, StageGate), Event{Kind: GatePass, Land: StageReview}},
		{"不在等验收不能验收", st(Running, StageGate), Event{Kind: Accept}},
		{"放进落地要给步骤", st(Todo, ""), Event{Kind: Deliver}},
		{"完成的不能受阻", st(Done, ""), Event{Kind: Block}},
		{"受阻的不能再受阻", st(Blocked, StageGate), Event{Kind: Block}},
		{"落地受阻不能审阅过", st(Blocked, StageMerge), Event{Kind: ReviewPass}},
		{"落地受阻无可交回", st(Blocked, StageMerge), Event{Kind: Bounce}},
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
	}, map[string][]DepState{
		"t3": {{ID: "t2", Status: Todo}},
		"t4": {{ID: "t9", Status: Done}},    // 树外、已完成
		"t5": {{ID: "t8", Status: Running}}, // 树外、没完成
		"t6": {{ID: "t2", Status: Todo}},
	})
	type r struct {
		ready bool
		wait  []string
	}
	want := map[string]r{"t1": {}, "t2": {}, "t3": {false, []string{"t2"}}, "t4": {true, nil},
		"t5": {false, []string{"t8"}}, "t6": {}, "t7": {}}
	var walk func(n *TreeNode)
	walk = func(n *TreeNode) {
		if w := want[n.ID]; n.Ready != w.ready || !reflect.DeepEqual(n.WaitingOn, w.wait) {
			t.Errorf("%s: ready=%v waiting=%v，want %+v", n.ID, n.Ready, n.WaitingOn, w)
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
