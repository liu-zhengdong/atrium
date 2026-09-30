package ledger

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestMeasure(t *testing.T) {
	const now = int64(100 * Week)
	day := int64(Week / 7)
	recent, old := now-day, now-30*day // 近 7 天里、7 天以前
	for _, c := range []struct {
		name string
		in   GoalInput
		week Window
		all  Window
	}{
		{name: "什么都没有：没有完成的活、没有选项单",
			in:   GoalInput{Now: now},
			week: Window{Text: "纠正 0（还没有完成的活）· 认可 —（还没有拍板的选项单）· 复发 0"},
			all:  Window{Text: "纠正 0（还没有完成的活）· 认可 —（还没有拍板的选项单）· 复发 0"}},
		{name: "有纠正、没有完成的活",
			in:   GoalInput{Now: now, Findings: []Finding{{ID: "t1", Source: SourceUser, Created: recent}}},
			week: Window{Corrections: 1, Text: "纠正 1（还没有完成的活）· 认可 —（还没有拍板的选项单）· 复发 0"},
			all:  Window{Corrections: 1, Text: "纠正 1（还没有完成的活）· 认可 —（还没有拍板的选项单）· 复发 0"}},
		{name: "纠正只数用户纠正，按建立时刻分近 7 天与累计；每 10 件按完成的活算",
			in: GoalInput{Now: now, Done: Count{Week: 5, All: 20}, Findings: []Finding{
				{ID: "t1", Source: SourceUser, Created: recent},
				{ID: "t2", Source: SourceUser, Created: now - Week}, // 正好 7 天：算近 7 天
				{ID: "t3", Source: SourceUser, Created: old},
				{ID: "t4", Source: SourceOrg, Created: recent},
			}},
			week: Window{Corrections: 2, Done: 5, Text: "纠正 2（每 10 件 4.0）· 认可 —（还没有拍板的选项单）· 复发 0"},
			all:  Window{Corrections: 3, Done: 20, Text: "纠正 3（每 10 件 1.5）· 认可 —（还没有拍板的选项单）· 复发 0"}},
		{name: "认可：选中的项 / 拍过板的项；有选项单但一项没选",
			in:   GoalInput{Now: now, Offered: Count{Week: 3, All: 6}, Picked: Count{Week: 0, All: 4}},
			week: Window{Offered: 3, Text: "纠正 0（还没有完成的活）· 认可 0/3 · 复发 0"},
			all:  Window{Picked: 4, Offered: 6, Text: "纠正 0（还没有完成的活）· 认可 4/6 · 复发 0"}},
		{name: "复发：新草稿建之前，同类里已有完成的任务",
			in: GoalInput{Now: now, Findings: []Finding{
				{ID: "t1", Class: "执行者可用性", Created: old - 2*day, Finished: old - day}, // 第一次，已完成
				{ID: "t2", Class: "执行者可用性", Created: recent},                           // 近 7 天复发
				{ID: "t3", Class: "执行者可用性", Created: old},                              // 7 天以前复发
				{ID: "t4", Class: "执行者可用性", Created: old - 3*day},                      // 建的时候同类还没完成：不算
				{ID: "t5", Class: "额度", Created: recent},                               // 同类没有完成的：不算
				{ID: "t6", Class: "额度", Created: old},                                  // 还没完成
				{ID: "t7", Class: "合入", Created: old, Finished: recent},                // 完成的那件自己不算
				{ID: "t8", Class: "合入", Created: recent},                               // 正好在完成那一刻建：不算
				{ID: "t9", Created: recent, Source: SourceOrg},                         // 没归类：不算
				{ID: "t10", Class: "执行者", Created: recent},                             // 名字相近也是另一类
			}},
			week: Window{Recurrences: 1, Recurred: []string{"t2"}, Text: "纠正 0（还没有完成的活）· 认可 —（还没有拍板的选项单）· 复发 1"},
			all:  Window{Recurrences: 2, Recurred: []string{"t2", "t3"}, Text: "纠正 0（还没有完成的活）· 认可 —（还没有拍板的选项单）· 复发 2"}},
		{name: "复发比的是同类里最早完成的那件",
			in: GoalInput{Now: now, Findings: []Finding{
				{ID: "t1", Class: "A", Created: old, Finished: recent},
				{ID: "t2", Class: "A", Created: old - 2*day, Finished: old - day},
				{ID: "t3", Class: "A", Created: old + day},
			}},
			week: Window{Text: "纠正 0（还没有完成的活）· 认可 —（还没有拍板的选项单）· 复发 0"},
			all:  Window{Recurrences: 2, Recurred: []string{"t1", "t3"}, Text: "纠正 0（还没有完成的活）· 认可 —（还没有拍板的选项单）· 复发 2"}},
	} {
		g := Measure(c.in)
		for _, w := range []struct {
			label     string
			got, want Window
		}{{"近 7 天", g.Week, c.week}, {"累计", g.All, c.all}} {
			if w.want.Recurred == nil {
				w.want.Recurred = []string{}
			}
			if w.got.Corrections != w.want.Corrections || w.got.Done != w.want.Done || w.got.Picked != w.want.Picked ||
				w.got.Offered != w.want.Offered || w.got.Recurrences != w.want.Recurrences ||
				!slices.Equal(w.got.Recurred, w.want.Recurred) || w.got.Text != w.want.Text {
				t.Errorf("%s／%s：\n got %+v\nwant %+v", c.name, w.label, w.got, w.want)
			}
		}
	}
}

// done 把一件任务直接标完成（经 Set，与 task set --status done 一样）。
func done(t *testing.T, db *store.DB, id string) {
	t.Helper()
	if _, err := Apply(context.Background(), db, id, Event{Kind: Set, To: Todo}, "secretary", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(context.Background(), db, id, Event{Kind: Set, To: Done}, "secretary", ""); err != nil {
		t.Fatal(err)
	}
}

func TestReadGoals(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	g, err := ReadGoals(ctx, db, store.Now())
	if err != nil || g.Week.Text != "纠正 0（还没有完成的活）· 认可 —（还没有拍板的选项单）· 复发 0" {
		t.Fatalf("空库：%+v %v", g, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO departments (id, name, created_at, updated_at) VALUES ('o1', '研发', 0, 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := Add(ctx, db, NewTask{Title: "不是草稿", Source: SourceOrg}, "a1"); code(err) != "usage" {
		t.Fatalf("来源只给草稿，got %v", err)
	}
	if _, err := Add(ctx, db, NewTask{Title: "x", Draft: true, Source: "boss"}, "a1"); code(err) != "usage" {
		t.Fatalf("未知来源应拒绝，got %v", err)
	}
	first, err := Add(ctx, db, NewTask{Title: "grok 没登录", Org: "o1", Draft: true, Source: SourceOrg, Class: " 执行者可用性 "}, "a1")
	if err != nil || first.Source != SourceOrg || first.Class != "执行者可用性" {
		t.Fatalf("加草稿：%+v %v", first, err)
	}
	done(t, db, first.ID)
	// 建立与完成时刻往前挪：下面的草稿与它可能落在同一毫秒
	if _, err := db.ExecContext(ctx, `UPDATE tasks SET created_at = created_at - 2000, finished_at = finished_at - 1000 WHERE id = ?`, first.ID); err != nil {
		t.Fatal(err)
	}
	again, err := Add(ctx, db, NewTask{Title: "模型名无效", Org: "o1", Draft: true, Source: SourceUser, Class: "执行者可用性"}, "a1")
	if err != nil {
		t.Fatal(err)
	}
	other, _ := Add(ctx, db, NewTask{Title: "别的", Org: "o1", Draft: true, Class: "执行者"}, "a1")
	classes, err := Classes(ctx, db)
	if err != nil || len(classes) != 2 || classes[0] != (Class{Name: "执行者可用性", Tasks: 2, Done: 1}) {
		t.Fatalf("已有的类：%+v %v", classes, err)
	}
	if !strings.Contains(classNote(other, classes), "已有的类：执行者可用性（2）") {
		t.Fatalf("新类的回执要列出已有的类：%s", classNote(other, classes))
	}
	// 写成两个名字的同一类用 task set 并起来
	if got, err := Edit(ctx, db, other.ID, Patch{Class: ptr("执行者可用性")}, "a1"); err != nil || got.Class != "执行者可用性" || got.Source != "" {
		t.Fatalf("改类：%+v %v", got, err)
	}
	now := store.Now()
	for _, q := range []string{
		`INSERT INTO choices (id, department, title, recommend, reason, status, created_by, created_at, decided_at)
			VALUES ('c1', 'o1', '方向', '1', '因为', 'picked', 'a1', 0, ?)`,
		`INSERT INTO choices (id, department, title, recommend, reason, status, created_by, created_at)
			VALUES ('c2', 'o1', '还没拍板', '1', '因为', 'open', 'a1', 0)`,
	} {
		if _, err := db.ExecContext(ctx, q, now); err != nil {
			t.Fatal(err)
		}
	}
	for _, o := range []struct {
		choice string
		pos    int
		task   any
	}{{"c1", 1, first.ID}, {"c1", 2, nil}, {"c1", 3, nil}, {"c2", 1, nil}} {
		if _, err := db.ExecContext(ctx, `INSERT INTO choice_options (choice, pos, title, gain, why_now, cost, if_not, evidence, task)
			VALUES (?, ?, 'x', 'x', 'x', 'x', 'x', 'x', ?)`, o.choice, o.pos, o.task); err != nil {
			t.Fatal(err)
		}
	}
	g, err = ReadGoals(ctx, db, store.Now())
	if err != nil {
		t.Fatal(err)
	}
	want := "纠正 1（每 10 件 10.0）· 认可 1/3 · 复发 2"
	if g.Week.Text != want || g.All.Text != want || !slices.Equal(g.Week.Recurred, []string{again.ID, other.ID}) {
		t.Fatalf("三个数：%+v", g)
	}
}

func ptr[T any](v T) *T { return &v }

func TestCorrection(t *testing.T) {
	accepting := Task{ID: "t5", Title: "写文章", Status: Running, Stage: StageAccept, Org: "o2"}
	for _, c := range []struct {
		name  string
		t     Task
		next  State
		kind  EventKind
		actor string
		title string
	}{
		{"用户验收时退回", accepting, State{Queued, StageNone}, Bounce, "u1", "用户验收时退回 t5：写文章"},
		{"秘书退回不算", accepting, State{Queued, StageNone}, Bounce, "secretary", ""},
		{"交付检查交回不算", Task{ID: "t5", Status: Running, Stage: StageGate}, State{Queued, StageNone}, Bounce, "u1", ""},
		{"用户取消", Task{ID: "t6", Title: "调研", Status: Todo}, State{Cancelled, StageNone}, Cancel, "u1", "用户取消 t6：调研"},
		{"负责人取消不算", Task{ID: "t6", Status: Todo}, State{Cancelled, StageNone}, Cancel, "a1", ""},
		{"取消草稿是清理，不算", Task{ID: "t7", Status: Draft}, State{Cancelled, StageNone}, Cancel, "u1", ""},
		{"用户验收通过不算", accepting, State{Done, StageNone}, Accept, "u1", ""},
	} {
		got, ok := Correction(c.t, c.next, c.kind, c.actor, "验收打回（u1）：结构乱")
		if ok != (c.title != "") || got.Title != c.title {
			t.Errorf("%s：%v %+v", c.name, ok, got)
			continue
		}
		if ok && (!got.Draft || got.Source != SourceUser || got.Org != c.t.Org || !strings.Contains(got.Detail, "结构乱")) {
			t.Errorf("%s：草稿要记来源、部门与原因：%+v", c.name, got)
		}
	}
}

func TestCorrectionRecorded(t *testing.T) {
	db, ctx := openDB(t), context.Background()
	a, _ := Add(ctx, db, NewTask{Title: "写文章"}, "secretary")
	for _, ev := range []Event{{Kind: Enqueue}, {Kind: Start}, {Kind: ExitOK}, {Kind: GatePass, AcceptBy: "user"}} {
		if _, err := Apply(ctx, db, a.ID, ev, "gates", ""); err != nil {
			t.Fatalf("%s：%v", ev.Kind, err)
		}
	}
	if _, err := Apply(ctx, db, a.ID, Event{Kind: Bounce}, "u1", "验收打回（u1）：结构乱"); err != nil {
		t.Fatal(err)
	}
	b, _ := Add(ctx, db, NewTask{Title: "调研"}, "secretary")
	if _, err := Apply(ctx, db, b.ID, Event{Kind: Cancel}, "u1", ""); err != nil {
		t.Fatal(err)
	}
	drafts, err := List(ctx, db, Filter{Status: []Status{Draft}})
	if err != nil || len(drafts) != 2 {
		t.Fatalf("应自动记两条草稿：%+v %v", drafts, err)
	}
	for _, d := range drafts {
		if d.Source != SourceUser {
			t.Fatalf("来源应为用户纠正：%+v", d)
		}
	}
	// 取消自动记的草稿不再生草稿
	if _, err := Apply(ctx, db, drafts[0].ID, Event{Kind: Cancel}, "u1", ""); err != nil {
		t.Fatal(err)
	}
	if n, _ := List(ctx, db, Filter{Status: []Status{Draft}}); len(n) != 1 {
		t.Fatalf("取消草稿不该再记：%+v", n)
	}
}

func TestSourceBy(t *testing.T) {
	for _, c := range []struct {
		src        Source
		name, want string
	}{{SourceOrg, "Atrium 负责人", "组织发现 · Atrium 负责人"}, {SourceUser, "用户", "用户纠正 · 用户"}, {SourceOrg, "", "组织发现"}, {"", "秘书", ""}} {
		if got := c.src.By(c.name); got != c.want {
			t.Errorf("%q %q：%q，应为 %q", c.src, c.name, got, c.want)
		}
	}
}
