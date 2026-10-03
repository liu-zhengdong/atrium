package ledger

import (
	"context"
	"errors"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func openDB(t *testing.T) *store.DB {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func code(err error) string {
	var ae *api.Error
	if errors.As(err, &ae) {
		return ae.Code
	}
	return ""
}

func TestLedgerLifecycle(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	a, err := Add(ctx, db, NewTask{Title: "  根  "}, "u1")
	if err != nil || a.ID != "t1" || a.Title != "根" || a.Status != Todo || a.Priority != Normal {
		t.Fatalf("add: %+v %v", a, err)
	}
	b, _ := Add(ctx, db, NewTask{Title: "子", Parent: "t1"}, "u1")
	c, err := Add(ctx, db, NewTask{Title: "后", Parent: "t1", After: []string{b.ID}}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Add(ctx, db, NewTask{Title: "x", After: []string{"t99"}}, "u1"); code(err) != "not_found" {
		t.Fatalf("不存在的依赖应 404，got %v", err)
	}
	if _, err := Add(ctx, db, NewTask{Title: "x", Skill: "nosuch"}, "u1"); code(err) != "not_found" {
		t.Fatalf("没登记的技能应 404，got %v", err)
	}
	if _, err := Add(ctx, db, NewTask{Title: "x", Org: "o1"}, "u1"); code(err) != "not_found" {
		t.Fatalf("不存在的部门应 404，got %v", err)
	}
	if _, err := Add(ctx, db, NewTask{Title: " "}, "u1"); code(err) != "usage" {
		t.Fatalf("空标题应拒绝，got %v", err)
	}
	if _, err := Add(ctx, db, NewTask{Title: "x", Priority: "high"}, "u1"); code(err) != "usage" {
		t.Fatalf("非法优先级应拒绝，got %v", err)
	}
	// 依赖成环要拒绝，且不留半截改动。
	if _, err := Edit(ctx, db, b.ID, Patch{After: &[]string{c.ID}}, "u1"); code(err) != "usage" {
		t.Fatalf("成环应拒绝，got %v", err)
	}
	if deps, _ := Deps(ctx, db, b.ID); len(deps) != 0 {
		t.Fatalf("回滚后 b 不该有依赖：%v", deps)
	}
	// 走一遍：派 → 起 → 交付 → 交付检查未通过交回 ×2 → 第三次转受阻。
	for _, ev := range []EventKind{Enqueue, Start, ExitOK, Bounce, Start, ExitOK, Bounce, Start, ExitOK} {
		if _, err := Apply(ctx, db, b.ID, Event{Kind: ev}, "dispatch", ""); err != nil {
			t.Fatalf("%s: %v", ev, err)
		}
	}
	got, err := Apply(ctx, db, b.ID, Event{Kind: Bounce}, "gates", "第三次不过")
	if err != nil || got.Status != Blocked {
		t.Fatalf("第三次交回应受阻：%+v %v", got, err)
	}
	if _, err := Apply(ctx, db, b.ID, Event{Kind: Start}, "x", ""); code(err) != "conflict" {
		t.Fatalf("非法转移应 409，got %v", err)
	}
	// 人工改回 todo 后交回次数重新算。
	if _, err := Apply(ctx, db, b.ID, Event{Kind: Set, To: Todo}, "u1", ""); err != nil {
		t.Fatal(err)
	}
	if n, _ := Bounces(ctx, db, b.ID); n != 0 {
		t.Fatalf("bounces = %d", n)
	}
	done, err := Apply(ctx, db, b.ID, Event{Kind: Set, To: Done}, "u1", "")
	if err != nil || done.FinishedAt == nil {
		t.Fatalf("完成应记结束时间：%+v %v", done, err)
	}
	// 状态变化都发了事件。
	var n int
	db.QueryRow(`SELECT count(*) FROM events WHERE kind = 'task.status' AND task = ?`, b.ID).Scan(&n)
	if n == 0 {
		t.Fatal("没发事件")
	}
	// b 完成后 c 就绪。
	deps, _ := Deps(ctx, db, c.ID)
	if waiting, broken := DepGate(deps); len(waiting)+len(broken) > 0 {
		t.Fatalf("c 应就绪：%v", deps)
	}
	sub, _ := Subtree(ctx, db, a.ID)
	sd, err := SubtreeDeps(ctx, db, a.ID)
	if err != nil || len(sd) != 1 || len(sd[c.ID]) != 1 || sd[c.ID][0] != (DepState{ID: b.ID, Status: Done}) {
		t.Fatalf("树内依赖 %+v %v", sd, err)
	}
	if tree := BuildTree(sub, sd); tree.Summary.Total != 2 || tree.Summary.Counts[Done] != 1 || !tree.Children[1].Ready {
		t.Fatalf("汇总 %+v，c 应能派", tree)
	}
	if err := Note(ctx, db, c.ID, "u1", "记一笔"); err != nil {
		t.Fatal(err)
	}
	if h, _ := History(ctx, db, c.ID, 5); len(h) != 2 || h[1].Kind != "note" {
		t.Fatalf("经历 %+v", h)
	}
	list, _ := List(ctx, db, Filter{})
	if len(list) != 2 { // b 完成了，列 a、c
		t.Fatalf("ls 缺省只列没结束的：%d", len(list))
	}
}

// 结果投处理人（缺省分派任务的人）：秘书派的失败要处理地投秘书，过程不投秘书；--owner 改投指定的人；定时任务记建定时任务的人。
func TestResultGoesToOwner(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	if _, err := db.Exec(`INSERT INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0), ('a2', 'leader', '乙', 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO departments (id, name, leader, created_at, updated_at) VALUES ('o1', '公司', 'a1', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	x, _ := Add(ctx, db, NewTask{Title: "秘书派的", Org: "o1"}, "u1")
	y, _ := Add(ctx, db, NewTask{Title: "周期", Org: "o1", By: "a1"}, "s1")
	z, err := Add(ctx, db, NewTask{Title: "交给乙", Org: "o1", Repo: "o/r", Owner: "a2"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Add(ctx, db, NewTask{Title: "坏", Owner: "a9"}, "u1"); code(err) != "not_found" || !strings.HasPrefix(err.Error(), "--owner") {
		t.Fatalf("处理人不存在应报 --owner：%v", err)
	}
	for _, c := range []struct {
		id   string
		want Parties
	}{{x.ID, Parties{"u1", "u1"}}, {y.ID, Parties{"a1", "a1"}}, {z.ID, Parties{"u1", "a2"}}} {
		if p, err := PartiesOf(ctx, db, c.id); err != nil || p != c.want {
			t.Fatalf("PartiesOf(%s) = %+v %v，应为 %+v", c.id, p, err, c.want)
		}
	}
	for _, id := range []string{x.ID, z.ID} {
		for _, k := range []EventKind{Enqueue, Start, ExitFail} {
			if _, err := Apply(ctx, db, id, Event{Kind: k}, "dispatch", "额度用尽"); err != nil {
				t.Fatal(err)
			}
		}
	}
	got := map[string]string{}
	rows, _ := db.Query(`SELECT task || ' ' || target, level || ' ' || count FROM events ORDER BY id`)
	for rows.Next() {
		var k, v string
		rows.Scan(&k, &v)
		got[k] = v
	}
	rows.Close()
	want := map[string]string{
		x.ID + " a1": "act 1", // 用户派到有负责人的部门：负责人收失败，秘书不收，过程不投
		z.ID + " a2": "act 1", // 处理人乙收失败，部门负责人与秘书都不收
	}
	if !maps.Equal(got, want) {
		t.Fatalf("事件 = %v，应为 %v", got, want)
	}
}

func TestDraftCap(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	full, err := org.Add(ctx, db, org.NewDept{Name: "运行时"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := org.Add(ctx, db, org.NewDept{Name: "网页"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Add(ctx, db, NewTask{Title: "没部门", Draft: true}, "secretary"); code(err) != "usage" {
		t.Fatalf("草稿要写部门，got %v", err)
	}
	for i := 0; i < org.MaxDrafts; i++ {
		d, err := Add(ctx, db, NewTask{Title: "草稿", Org: full.ID, Draft: true}, "secretary")
		if err != nil || d.Status != Draft {
			t.Fatalf("第 %d 件草稿：%+v %v", i+1, d, err)
		}
	}
	_, err = Add(ctx, db, NewTask{Title: "满了", Org: full.ID, Draft: true}, "secretary")
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Code != "limit" || !strings.Contains(ae.Message, "部门 "+full.ID+" 的") ||
		!strings.Contains(ae.Message, "满了找部门负责人") || ae.Next != "atrium task ls --org "+full.ID+" --status draft" {
		t.Fatalf("满了应报 limit，写清哪个部门、找谁、看哪：%+v", err)
	}
	// 一个部门满了不影响别的部门。
	elsewhere, err := Add(ctx, db, NewTask{Title: "别的部门", Org: other.ID, Draft: true}, "secretary")
	if err != nil {
		t.Fatalf("别的部门照常记草稿：%v", err)
	}
	if _, err := Edit(ctx, db, elsewhere.ID, Patch{Org: ptr(full.ID)}, "secretary"); code(err) != "limit" {
		t.Fatalf("草稿改到满了的部门应拒绝，got %v", err)
	}
	todo, err := Add(ctx, db, NewTask{Title: "待派", Org: full.ID}, "secretary")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(ctx, db, todo.ID, Event{Kind: Set, To: Draft}, "secretary", ""); code(err) != "limit" {
		t.Fatalf("满了不能退回草稿，got %v", err)
	}
	if _, err := Apply(ctx, db, "t1", Event{Kind: Set, To: Todo}, "secretary", ""); err != nil {
		t.Fatal(err)
	}
	if got, err := Apply(ctx, db, todo.ID, Event{Kind: Set, To: Draft}, "secretary", ""); err != nil || got.Status != Draft {
		t.Fatalf("腾出位置后可以退回草稿：%+v %v", got, err)
	}
}

func TestTaskDir(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	root := t.TempDir() // 本机规则下的绝对路径：Windows 上 /w/site 没有盘符，不算绝对路径
	site, blog, sep := filepath.Join(root, "site"), filepath.Join(root, "blog"), string(filepath.Separator)
	for _, c := range []struct {
		in   NewTask
		want string // 错误码；空为能建
	}{
		{NewTask{Title: "x", Dir: "notes"}, "usage"},           // 不是绝对路径
		{NewTask{Title: "x", Dir: site + "\nb"}, "usage"},      // 换行
		{NewTask{Title: "x", Dir: site, Repo: "o/r"}, "usage"}, // 与仓库只给一个
		{NewTask{Title: "x", Repo: "o/r"}, ""},                 // 只有仓库
		{NewTask{Title: "x", Dir: site + sep}, ""},             // 只有工作地点
	} {
		if _, err := Add(ctx, db, c.in, "u1"); code(err) != c.want {
			t.Errorf("Add(%+v) = %v，应为 %q", c.in, err, c.want)
		}
	}
	a, _ := Add(ctx, db, NewTask{Title: "写文章", Dir: blog + sep}, "u1")
	if a.Dir != blog {
		t.Fatalf("工作地点应存成干净的路径：%q", a.Dir)
	}
	if l, _ := List(ctx, db, Filter{}); l[0].Dir != blog {
		t.Fatalf("List 应带工作地点：%+v", l[0])
	}
	if s, _ := Subtree(ctx, db, a.ID); s[0].Dir != blog {
		t.Fatalf("Subtree 应带工作地点：%+v", s[0])
	}
	repo := "o/r"
	if _, err := Edit(ctx, db, a.ID, Patch{Repo: &repo}, "u1"); code(err) != "usage" {
		t.Fatalf("有工作地点时再给仓库应拒绝，got %v", err)
	}
	empty := ""
	if got, err := Edit(ctx, db, a.ID, Patch{Dir: &empty, Repo: &repo}, "u1"); err != nil || got.Dir != "" || got.Repo != repo {
		t.Fatalf("清掉工作地点换成仓库：%+v %v", got, err)
	}
}

func TestAssignee(t *testing.T) {
	for name, c := range map[string]struct {
		t     Task
		p     Parties
		actor string
		want  string
	}{
		"秘书交给负责人去拆":   {Task{Status: Todo}, Parties{"secretary", "a1"}, "secretary", "a1"},
		"负责人给自己建":     {Task{Status: Todo}, Parties{"a1", "a1"}, "a1", ""},
		"交给上一层负责人":    {Task{Status: Todo}, Parties{"a2", "a1"}, "a2", "a1"},
		"负责人自己建的由秘书改": {Task{Status: Todo}, Parties{"a1", "a1"}, "secretary", ""},
		"负责人自己接过来":    {Task{Status: Todo}, Parties{"secretary", "a1"}, "a1", ""},
		"有仓库是具体的活":    {Task{Status: Todo, Repo: "/r"}, Parties{"secretary", "a1"}, "secretary", ""},
		"有工作地点是具体的活":  {Task{Status: Todo, Dir: "/d"}, Parties{"secretary", "a1"}, "secretary", ""},
		"草稿不唤醒":       {Task{Status: Draft}, Parties{"secretary", "a1"}, "secretary", ""},
		"已派出去的不再拆":    {Task{Status: Running}, Parties{"secretary", "a1"}, "secretary", ""},
		"处理人是秘书":      {Task{Status: Todo}, Parties{"u1", "secretary"}, "u1", ""},
		"没写处理人":       {Task{Status: Todo}, Parties{"secretary", ""}, "secretary", ""},
	} {
		if got := Assignee(c.t, c.p, c.actor); got != c.want {
			t.Errorf("%s：得到 %q，应为 %q", name, got, c.want)
		}
	}
}

func TestTaken(t *testing.T) {
	for name, c := range map[string]struct {
		t     Task
		p     Parties
		actor string
		want  bool
	}{
		"交给负责人拆着":  {Task{Status: Todo}, Parties{"secretary", "a1"}, "secretary", true},
		"负责人自己改":   {Task{Status: Todo}, Parties{"secretary", "a1"}, "a1", false},
		"执行者在跑":    {Task{Status: Running, Repo: "o/r"}, Parties{"u1", "u1"}, "u1", true},
		"已交付在交付检查": {Task{Status: Running, Stage: StageGate, Repo: "o/r"}, Parties{"u1", "u1"}, "u1", false},
		"排着还没拉起":   {Task{Status: Queued, Repo: "o/r"}, Parties{"u1", "u1"}, "u1", false},
		"待派没人接":    {Task{Status: Todo}, Parties{"u1", "u1"}, "u1", false},
	} {
		if got := Taken(c.t, c.p, c.actor); got != c.want {
			t.Errorf("%s：得到 %v，应为 %v", name, got, c.want)
		}
	}
}

// task set --detail：交给负责人拆着的、执行者在跑的，改了说明经 Tell 捎过去；没人在做的、负责人自己改的、这次才交出去的不捎。
func TestEditDetailTells(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	if _, err := db.Exec(`INSERT INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO departments (id, parent, name, leader, created_at, updated_at) VALUES ('o1', NULL, '一', 'a1', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	var told []string
	old := Tell
	Tell = func(_ context.Context, id, text, by string) error {
		told = append(told, id+" "+by+" "+text)
		return nil
	}
	t.Cleanup(func() { Tell = old })
	edit := func(id, detail, actor string) []string {
		t.Helper()
		told = nil
		if _, err := Edit(ctx, db, id, Patch{Detail: &detail}, actor); err != nil {
			t.Fatal(err)
		}
		return told
	}

	goal, _ := Add(ctx, db, NewTask{Title: "拆分任务", Owner: "a1"}, "secretary")
	if got := edit(goal.ID, "也要改网页", "secretary"); len(got) != 1 || got[0] != goal.ID+" secretary 说明已改，以最新说明为准：\n也要改网页" {
		t.Fatalf("交给负责人拆着的应捎过去：%q", got)
	}
	if got := edit(goal.ID, "也要改网页", "secretary"); len(got) != 0 {
		t.Fatalf("说明没变不捎：%q", got)
	}
	if got := edit(goal.ID, "负责人自己补", "a1"); len(got) != 0 {
		t.Fatalf("负责人自己改不捎：%q", got)
	}
	todo, _ := Add(ctx, db, NewTask{Title: "排着的", Repo: "o/r"}, "u1")
	if got := edit(todo.ID, "新说明", "u1"); len(got) != 0 {
		t.Fatalf("没人在做的不捎：%q", got)
	}
	for _, k := range []EventKind{Enqueue, Start} {
		if _, err := Apply(ctx, db, todo.ID, Event{Kind: k}, "dispatch", ""); err != nil {
			t.Fatal(err)
		}
	}
	if got := edit(todo.ID, strings.Repeat("长", maxRetell+1), "u1"); len(got) != 1 || !strings.HasSuffix(got[0], "…（全文见 atrium task show "+todo.ID+"）") {
		t.Fatalf("在跑的应捎过去，太长的截断：%q", got)
	}
	// 同一次改动里才交给负责人：交出去的 task.assigned 已带最新说明，不再捎。
	x, _ := Add(ctx, db, NewTask{Title: "还没交"}, "secretary")
	detail, owner := "说明", "a1"
	told = nil
	if _, err := Edit(ctx, db, x.ID, Patch{Detail: &detail, Owner: &owner}, "secretary"); err != nil || len(told) != 0 {
		t.Fatalf("这次才交出去不捎：%q %v", told, err)
	}
}

// task set --owner：改处理人记进经历、结果改投新处理人；交给负责人去拆的唤醒它（草稿等转待派），它管不到的部门拒绝。
func TestSetOwner(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	for _, q := range []string{
		`INSERT INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0), ('a2', 'leader', '乙', 0)`,
		`INSERT INTO departments (id, parent, name, leader, created_at, updated_at) VALUES
			('o1', NULL, '一', 'a1', 0, 0), ('o2', 'o1', '二', 'a2', 0, 0), ('o3', NULL, '三', NULL, 0, 0)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	assigned := func(id string) []string {
		var out []string
		rows, _ := db.Query(`SELECT target FROM events WHERE task = ? AND kind = ? ORDER BY id`, id, events.TaskAssigned)
		defer rows.Close()
		for rows.Next() {
			var s string
			rows.Scan(&s)
			out = append(out, s)
		}
		return out
	}
	owner := func(v string) Patch { return Patch{Owner: &v} }
	owners := func(id string) Parties { p, _ := PartiesOf(ctx, db, id); return p }

	// 秘书排着的待派任务交给乙：落到乙负责的 o2，唤醒乙，经历里有这次改动。
	x, _ := Add(ctx, db, NewTask{Title: "排着的"}, "secretary")
	got, err := Edit(ctx, db, x.ID, owner("a2"), "secretary")
	if err != nil || got.Org != "o2" || owners(x.ID) != (Parties{"secretary", "a2"}) || !slices.Equal(assigned(x.ID), []string{"a2"}) {
		t.Fatalf("交给乙：%+v %+v %v %v", got, owners(x.ID), assigned(x.ID), err)
	}
	if h, _ := History(ctx, db, x.ID, 5); h[len(h)-1].Kind != "edited" || !strings.Contains(h[len(h)-1].Body, `"owner":"a2"`) {
		t.Fatalf("改处理人应记进经历：%+v", h)
	}
	// 再交一次同一位不重复唤醒；改别的字段也不唤醒。
	title := "排着的（改名）"
	Edit(ctx, db, x.ID, owner("a2"), "secretary")
	Edit(ctx, db, x.ID, Patch{Title: &title}, "secretary")
	if n := len(assigned(x.ID)); n != 1 {
		t.Fatalf("同一位只唤醒一次：%d", n)
	}
	// 越权：乙管不到 o1（甲的部门，乙在它下面）、o3；不存在的身份。
	y, _ := Add(ctx, db, NewTask{Title: "甲部门的", Org: "o1"}, "secretary")
	if _, err := Edit(ctx, db, y.ID, owner("a2"), "secretary"); code(err) != "usage" || !strings.HasPrefix(err.Error(), "--owner") {
		t.Fatalf("乙管不到 o1 应拒绝：%v", err)
	}
	if _, err := Edit(ctx, db, y.ID, owner("a9"), "secretary"); code(err) != "not_found" {
		t.Fatalf("不存在的处理人应拒绝：%v", err)
	}
	if owners(y.ID).Owner != "secretary" || len(assigned(y.ID)) != 0 {
		t.Fatalf("拒绝后不应改动：%+v %v", owners(y.ID), assigned(y.ID))
	}
	// 甲管得着下属部门 o2；同时改部门到乙的 o2 也行。
	if _, err := Edit(ctx, db, y.ID, owner("a1"), "secretary"); err != nil || !slices.Equal(assigned(y.ID), []string{"a1"}) {
		t.Fatalf("交给甲：%v %v", assigned(y.ID), err)
	}
	o2 := "o2"
	if _, err := Edit(ctx, db, y.ID, Patch{Owner: ptr("a2"), Org: &o2}, "secretary"); err != nil || !slices.Equal(assigned(y.ID), []string{"a1", "a2"}) {
		t.Fatalf("改到 o2 交给乙：%v %v", assigned(y.ID), err)
	}
	// 结果改投新处理人；给空串回到任务分派人。
	if _, err := Edit(ctx, db, y.ID, owner(""), "secretary"); err != nil || owners(y.ID) != (Parties{"secretary", "secretary"}) {
		t.Fatalf("空串回到任务分派人：%+v %v", owners(y.ID), err)
	}

	// 草稿：改处理人不唤醒，转待派时才交出去。
	d, _ := Add(ctx, db, NewTask{Title: "草稿", Org: "o1", Draft: true}, "secretary")
	if _, err := Edit(ctx, db, d.ID, owner("a1"), "secretary"); err != nil || len(assigned(d.ID)) != 0 {
		t.Fatalf("草稿不唤醒：%v %v", assigned(d.ID), err)
	}
	if got, err := Apply(ctx, db, d.ID, Event{Kind: Set, To: Todo}, "secretary", ""); err != nil || got.Org != "o1" ||
		!slices.Equal(assigned(d.ID), []string{"a1"}) {
		t.Fatalf("转待派时交给甲：%+v %v %v", got, assigned(d.ID), err)
	}
}

func TestLeaderSelfDoneReturnsToAssigner(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	if _, err := db.Exec(`INSERT INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO departments (id, name, leader, created_at, updated_at) VALUES ('o1', '公司', 'a1', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	task, err := Add(ctx, db, NewTask{Title: "研究报告", Org: "o1", Owner: "a1"}, "secretary")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(ctx, db, task.ID, Event{Kind: Set, To: Done}, "a1", ""); err != nil {
		t.Fatal(err)
	}
	got, err := events.Pending(ctx, db, events.Secretary, true, 10)
	if err != nil || len(got) != 1 || got[0].Kind != events.TaskStatus || got[0].Level != events.Info || got[0].Task != task.ID {
		t.Fatalf("秘书应收到一条知会级的完成结果（完成回执不进秘书的要处理）：%+v %v", got, err)
	}
}

// 交给负责人去拆的任务：没写部门落到它负责的那个部门，并给它发一条要处理的 task.assigned。
func TestAddAssigned(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	for _, q := range []string{
		`INSERT INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0), ('a2', 'leader', '乙', 0)`,
		`INSERT INTO departments (id, parent, name, leader, created_at, updated_at) VALUES
			('o1', NULL, '一', 'a1', 0, 0), ('o2', NULL, '二', 'a2', 0, 0), ('o3', NULL, '三', 'a2', 0, 0)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	goal, err := Add(ctx, db, NewTask{Title: "接活", Owner: "a1"}, "secretary")
	if err != nil || goal.Org != "o1" {
		t.Fatalf("应落到 o1：%+v %v", goal, err)
	}
	var target, level string
	if err := db.QueryRow(`SELECT target, level FROM events WHERE task = ? AND kind = ?`, goal.ID, events.TaskAssigned).
		Scan(&target, &level); err != nil || target != "a1" || level != events.Act {
		t.Fatalf("应给 a1 发要处理的 task.assigned：%s %s %v", target, level, err)
	}
	if _, err := Add(ctx, db, NewTask{Title: "两个部门", Owner: "a2"}, "secretary"); err == nil || !strings.Contains(err.Error(), "--org") {
		t.Fatalf("负责多个部门要写 --org：%v", err)
	}
	sub, err := Add(ctx, db, NewTask{Title: "子任务", Parent: goal.ID}, "a1")
	if err != nil || sub.Org != "o1" {
		t.Fatalf("%+v %v", sub, err)
	}
	var n int
	db.QueryRow(`SELECT count(*) FROM events WHERE kind = ?`, events.TaskAssigned).Scan(&n)
	if n != 1 {
		t.Fatalf("负责人自己建的子任务不再唤醒自己：%d 条", n)
	}
}

func TestDeptRepo(t *testing.T) {
	one := []string{"o/r"}
	cases := []struct {
		name  string
		t     Task
		repos []string
		want  string
	}{
		{"部门一个仓库：补上", Task{Status: Todo}, one, "o/r"},
		{"草稿直接派也补", Task{Status: Draft}, one, "o/r"},
		{"失败后重派也补", Task{Status: Failed}, one, "o/r"},
		{"有仓库：不补", Task{Status: Todo, Repo: "x/y"}, one, ""},
		{"有工作地点：不补", Task{Status: Todo, Dir: "/w"}, one, ""},
		{"部门没有仓库", Task{Status: Todo}, nil, ""},
		{"部门多个仓库：分不出，不补", Task{Status: Todo}, []string{"o/a", "o/b"}, ""},
		{"在跑的不动", Task{Status: Running}, one, ""},
		{"在交付的不动", Task{Status: Running, Stage: StageGate}, one, ""},
	}
	for _, c := range cases {
		if got := DeptRepo(c.t, c.repos); got != c.want {
			t.Errorf("%s：得到 %q，应为 %q", c.name, got, c.want)
		}
	}
}

// 分派任务入口补部门的仓库：建任务时不补（运行时建的审阅、定时任务也不补），UseDeptRepo 才写上并记经历。
func TestUseDeptRepo(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	if _, err := db.Exec(`INSERT INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0)`); err != nil {
		t.Fatal(err)
	}
	d1, err := org.Add(ctx, db, org.NewDept{Name: "有仓库", Repos: []string{"o/r"}})
	if err != nil {
		t.Fatal(err)
	}
	d2, err := org.Add(ctx, db, org.NewDept{Name: "两个仓库", Repos: []string{"o/a", "o/b"}})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		in   NewTask
		want string
	}{
		{"草稿", NewTask{Org: d1.ID, Draft: true}, "o/r"},
		{"交给负责人的草稿", NewTask{Org: d1.ID, Owner: "a1", Draft: true}, "o/r"},
		{"部门多个仓库", NewTask{Org: d2.ID}, ""},
		{"没部门", NewTask{}, ""},
	}
	for _, c := range cases {
		c.in.Title = c.name
		task, err := Add(ctx, db, c.in, "u1")
		if err != nil || task.Repo != "" {
			t.Fatalf("%s：建任务时不补仓库：%+v %v", c.name, task, err)
		}
		if err := UseDeptRepo(ctx, db, task.ID, "secretary"); err != nil {
			t.Fatalf("%s：%v", c.name, err)
		}
		if task, _ = Get(ctx, db, task.ID); task.Repo != c.want {
			t.Errorf("%s：仓库 %q，应为 %q", c.name, task.Repo, c.want)
		}
	}
	if err := UseDeptRepo(ctx, db, "t99", "u1"); code(err) == "" {
		t.Errorf("不存在的任务应报错，得到 %v", err)
	}
}
