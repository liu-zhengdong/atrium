package agenda

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func code(err error) string {
	var ae *api.Error
	if errors.As(err, &ae) {
		return ae.Code
	}
	if err != nil {
		return "other"
	}
	return ""
}

func ms(t time.Time) int64 { return t.UnixMilli() }

func TestParse(t *testing.T) {
	for s, want := range map[string]int64{"1h": hour, "90m": 90 * minute, "7d": 7 * day, "2w": 14 * day, "366d": 366 * day,
		"59m": -1, "367d": -1, "0d": -1, "1y": -1, "": -1, " 1d": -1} {
		got, err := ParseEvery(s)
		if (want < 0) != (err != nil) || (want > 0 && got != want) {
			t.Errorf("%q → %d %v", s, got, err)
		}
		if want > 0 && EveryText(got) != map[string]string{"90m": "90m", "2w": "14d"}[s] && EveryText(got) != s {
			t.Errorf("EveryText(%q) = %s", s, EveryText(got))
		}
	}
	for _, c := range []struct {
		s     string
		every int64
		want  int
	}{{"09:30", day, 570}, {"0:05", 7 * day, 5}, {"24:00", day, -1}, {"09:60", day, -1}, {"9", day, -1}, {"09:30", 12 * hour, -1}} {
		got, err := ParseAt(c.s, c.every)
		if (c.want < 0) != (err != nil) || (c.want >= 0 && got != c.want) {
			t.Errorf("%q %d → %d %v", c.s, c.every, got, err)
		}
	}
}

func TestClock(t *testing.T) {
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("没有时区数据")
	}
	at := 9 * 60
	now := ms(time.Date(2026, 3, 7, 10, 0, 0, 0, ny)) // 夏令时 3 月 8 日开始
	if got := FirstDue(now, day, &at, ny); got != ms(time.Date(2026, 3, 8, 9, 0, 0, 0, ny)) {
		t.Fatalf("今天钟点已过，排明天：%v", time.UnixMilli(got).In(ny))
	}
	early := ms(time.Date(2026, 3, 7, 8, 0, 0, 0, ny))
	if got := FirstDue(early, day, &at, ny); got != ms(time.Date(2026, 3, 7, 9, 0, 0, 0, ny)) {
		t.Fatal("今天钟点没过，排今天")
	}
	if got := FirstDue(now, 12*hour, nil, ny); got != now+12*hour {
		t.Fatal("没定钟点：一个周期后")
	}
	// 跨夏令时仍是 9 点。
	due := ms(time.Date(2026, 3, 7, 9, 0, 0, 0, ny))
	if got := Following(due, day, &at, ny); time.UnixMilli(got).In(ny).Hour() != 9 || got-due != 23*hour {
		t.Fatalf("跨夏令时：%v", time.UnixMilli(got).In(ny))
	}
	cases := []struct {
		name        string
		due, now    int64
		at          *int
		every       int64
		slots, next int64
	}{
		{"没到", 100 * day, 99 * day, nil, day, 0, 100 * day},
		{"刚到", 100 * day, 100 * day, nil, day, 1, 101 * day},
		{"停机 10 天", 100 * day, 110*day + hour, nil, day, 11, 111 * day},
		{"停机一年", 100 * day, 465 * day, nil, 7 * day, 53, 471 * day},
		{"定钟点停机 40 天", due, due + 40*day + 2*hour, &at, day, 41, ms(time.Date(2026, 4, 17, 9, 0, 0, 0, ny))},
	}
	for _, c := range cases {
		slots, next := CatchUp(c.due, c.every, c.at, c.now, ny)
		if slots != c.slots || next != c.next {
			t.Errorf("%s：slots=%d next=%v，想要 %d %v", c.name, slots, time.UnixMilli(next).In(ny), c.slots, time.UnixMilli(c.next).In(ny))
		}
	}
	if v := Due(10*day, day, nil, "", 9*day, ny); v.Kind != "wait" {
		t.Fatal("没到点等")
	}
	if v := Due(10*day, day, nil, "t3", 13*day, ny); v.Kind != "skip" || v.Open != "t3" || v.Missed != 3 || v.Next != 14*day {
		t.Fatalf("上一轮没结束跳过：%+v", v)
	}
	if v := Due(10*day, day, nil, "", 13*day, ny); v.Kind != "run" || v.Missed != 3 {
		t.Fatalf("停机错过只补一轮：%+v", v)
	}
	for s, open := range map[string]bool{"todo": true, "queued": true, "running": true, "blocked": true, "done": false, "failed": false, "cancelled": false} {
		if OpenStatus(s) != open {
			t.Errorf("OpenStatus(%s)", s)
		}
	}
}

func sample(n int) ChoiceInput {
	in := ChoiceInput{Title: "下一步", Recommend: []int{1}, Reason: "最快见效"}
	for i := 0; i < n; i++ {
		in.Options = append(in.Options, OptionInput{Title: "方向" + string(rune('A'+i)), Gain: "多", WhyNow: "现在", Cost: "少", IfNot: "慢", Evidence: "数据"})
	}
	return in
}

func TestCheckChoice(t *testing.T) {
	bad := sample(3)
	bad.Options[1].IfNot = ""
	noRec := sample(3)
	noRec.Recommend = nil
	dupRec := sample(3)
	dupRec.Recommend = []int{1, 1}
	outRec := sample(3)
	outRec.Recommend = []int{4}
	badOrg := sample(3)
	badOrg.Options[0].Org = "wrong"
	for name, c := range map[string]struct {
		in   ChoiceInput
		code string
	}{
		"3 项": {sample(3), ""}, "5 项": {sample(5), ""}, "2 项": {sample(2), "usage"}, "6 项": {sample(6), "limit"},
		"缺一栏": {bad, "usage"}, "没推荐": {noRec, "usage"}, "推荐重复": {dupRec, "usage"}, "推荐越界": {outRec, "usage"},
		"部门不是 oN": {badOrg, "usage"},
	} {
		if got := code(CheckChoice(c.in)); got != c.code {
			t.Errorf("%s：%s，想要 %s", name, got, c.code)
		}
	}
	opts := func(tasks ...string) []Option {
		var out []Option
		for i, task := range tasks {
			out = append(out, Option{Pos: i + 1, OptionInput: OptionInput{Title: string(rune('A' + i))}, Task: task})
		}
		return out
	}
	for name, c := range map[string]struct {
		c    Choice
		want string
	}{
		"选了 A、C": {Choice{Status: "picked", Options: opts("t1", "", "t2")}, "c1「下一步」没选：B"},
		"整份不做":   {Choice{Status: "passed", Note: "不急", Options: opts("", "", "")}, "c1「下一步」没选：A、B、C（用户说明：不急）"},
		"全选":     {Choice{Status: "picked", Options: opts("t1", "t2", "t3")}, ""},
		"没拍板":    {Choice{Status: "open", Options: opts("", "", "")}, ""},
	} {
		c.c.ID, c.c.Title = "c1", "下一步"
		if got := Unpicked(c.c); got != c.want {
			t.Errorf("%s → %q", name, got)
		}
	}
}

func setup(t *testing.T) (*app.Env, string) {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	d, err := org.Add(context.Background(), db, org.NewDept{Name: "公司"})
	if err != nil {
		t.Fatal(err)
	}
	return &app.Env{DB: db, Pause: &pause.Store{DB: db}, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}, d.ID
}

func TestChoiceFlow(t *testing.T) {
	env, dept := setup(t)
	ctx := context.Background()
	in := sample(4)
	in.Org = dept
	c, err := AddChoice(ctx, env.DB, in, "", "u1")
	if err != nil || c.ID != "c1" || len(c.Options) != 4 {
		t.Fatalf("%+v %v", c, err)
	}
	var n int
	env.DB.QueryRow(`SELECT count(*) FROM events WHERE kind = 'choice.open' AND target = 'secretary'`).Scan(&n)
	if n != 1 {
		t.Fatal("登记选项单要投给秘书")
	}
	c, err = Decide(ctx, env.DB, c.ID, []int{1, 3}, "先快后稳", "u1")
	if err != nil || c.Status != "picked" || c.Options[0].Task == "" || c.Options[1].Task != "" || c.Note != "先快后稳" {
		t.Fatalf("%+v %v", c, err)
	}
	task, _ := ledger.Get(ctx, env.DB, c.Options[2].Task)
	if task.Org != dept || !strings.Contains(task.Detail, "不做会怎样：慢") || !strings.Contains(task.Detail, "先快后稳") {
		t.Fatalf("任务详述 = 选项全文：%+v", task)
	}
	if _, err := Decide(ctx, env.DB, c.ID, nil, "", "u1"); code(err) != "conflict" {
		t.Fatal("拍过板的不能再拍")
	}
	c2, _ := AddChoice(ctx, env.DB, in, "", "u1")
	if _, err := Decide(ctx, env.DB, c2.ID, []int{9}, "", "u1"); code(err) != "usage" {
		t.Fatal("越界的选项应拒绝")
	}
	c2, err = Decide(ctx, env.DB, c2.ID, nil, "不急", "u1")
	if err != nil || c2.Status != "passed" {
		t.Fatalf("%+v %v", c2, err)
	}

	// 选项指定部门：建任务落在该部门，处理人是该部门负责人，并唤醒（发 task.assigned）。
	ldr, _ := org.AddLeader(ctx, env.DB, org.NewLeader{Name: "分部主管", Workers: []string{"fake"}})
	dept2, _ := org.Add(ctx, env.DB, org.NewDept{Name: "分部", Leader: ldr.ID})
	inWithDept := sample(3)
	inWithDept.Org = dept
	inWithDept.Options[0].Org = dept2.ID
	c3, err := AddChoice(ctx, env.DB, inWithDept, "", "u1")
	if err != nil {
		t.Fatal(err)
	}
	if c3.Options[0].Org != dept2.ID {
		t.Fatalf("选项应记下归属部门：%+v", c3.Options[0])
	}
	c3, err = Decide(ctx, env.DB, c3.ID, []int{1}, "交给分部", "u1")
	if err != nil {
		t.Fatal(err)
	}
	tWithDept, _ := ledger.Get(ctx, env.DB, c3.Options[0].Task)
	if tWithDept.Org != dept2.ID {
		t.Fatalf("任务应落在分部 %s，得到 %s", dept2.ID, tWithDept.Org)
	}
	parties, _ := ledger.PartiesOf(ctx, env.DB, tWithDept.ID)
	if parties.Owner != ldr.ID {
		t.Fatalf("处理人应是分部负责人 %s，得到 %s", ldr.ID, parties.Owner)
	}
	var assignedCount int
	env.DB.QueryRow(`SELECT count(*) FROM events WHERE kind = 'task.assigned' AND target = ?`, ldr.ID).Scan(&assignedCount)
	if assignedCount != 1 {
		t.Fatalf("应给分部负责人发一条 task.assigned 事件，得到 %d 条", assignedCount)
	}
	for i := 0; i < org.MaxChoices; i++ {
		if _, err := AddChoice(ctx, env.DB, in, "", "u1"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := AddChoice(ctx, env.DB, in, "", "u1"); code(err) != "limit" {
		t.Fatalf("待拍板满了应拒绝：%v", err)
	}
}

func TestSettle(t *testing.T) {
	env, dept := setup(t)
	ctx := context.Background()
	task, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "调研", Org: dept}, "u1")
	if c, err := Settle(ctx, env.DB, task.ID, nil); c != nil || err != nil {
		t.Fatal("没有 choice.json 什么都不做")
	}
	if _, err := Settle(ctx, env.DB, task.ID, []byte(`{"title":"x","options":[],"extra":1}`)); code(err) != "usage" {
		t.Fatalf("不认识的字段应拒绝：%v", err)
	}
	raw := []byte(`{"title":"下一步","options":[` + strings.Repeat(`{"title":"A","gain":"g","why_now":"w","cost":"c","if_not":"i","evidence":"e"},`, 2) +
		`{"title":"B","gain":"g","why_now":"w","cost":"c","if_not":"i","evidence":"e"}],"recommend":[2],"reason":"r"}`)
	c, err := Settle(ctx, env.DB, task.ID, raw)
	if err != nil || c.Org != dept || c.Task != task.ID {
		t.Fatalf("%+v %v", c, err)
	}
	again, err := Settle(ctx, env.DB, task.ID, raw)
	if err != nil || again.ID != c.ID {
		t.Fatal("同一件任务只登记一次")
	}
}

func TestScheduleTick(t *testing.T) {
	env, dept := setup(t)
	ctx := context.Background()
	var queued []string
	Enqueue = func(ctx context.Context, env *app.Env, task, actor string) error {
		queued = append(queued, task)
		return nil
	}
	t.Cleanup(func() { Enqueue = nil })
	loc := time.UTC
	start := ms(time.Date(2026, 9, 1, 8, 0, 0, 0, loc))
	x, err := AddSchedule(ctx, env.DB, "", NewSchedule{Org: dept, Title: "巡检", Kind: "research", Every: "1d", At: "09:00"}, "u1", start, loc)
	if err != nil || x.ID != "s1" || x.NextAt != start+hour {
		t.Fatalf("%+v %v", x, err)
	}
	if _, err := AddSchedule(ctx, env.DB, "", NewSchedule{Org: dept, Title: "x", Every: "1d", Skill: "nope"}, "u1", start, loc); code(err) != "not_found" {
		t.Fatal("没有的技能应拒绝")
	}
	// 没到点。
	Tick(ctx, env, start+30*minute, loc)
	if len(queued) != 0 {
		t.Fatal("没到点不该生成")
	}
	// 到点：生成并派发，附调研做法。
	Tick(ctx, env, start+hour, loc)
	if len(queued) != 1 {
		t.Fatalf("到点应生成一轮：%v", queued)
	}
	task, _ := ledger.Get(ctx, env.DB, queued[0])
	if task.Title != "巡检（09-01）" || !strings.Contains(task.Detail, ChoiceFile) || task.Org != dept {
		t.Fatalf("%+v", task)
	}
	// 第二天到点，上一轮没结束：跳过记一笔。
	Tick(ctx, env, start+day+hour, loc)
	x, _ = GetSchedule(ctx, env.DB, "s1")
	if len(queued) != 1 || x.Skips != 1 || !strings.Contains(x.LastNote, "没结束") {
		t.Fatalf("应跳过：%+v", x)
	}
	// 上一轮结束，停机 5 天：只补一轮。
	ledger.Apply(ctx, env.DB, task.ID, ledger.Event{Kind: ledger.Cancel}, "u1", "")
	Tick(ctx, env, start+7*day+2*hour, loc)
	x, _ = GetSchedule(ctx, env.DB, "s1")
	if len(queued) != 2 || !strings.Contains(x.LastNote, "错过") || x.NextAt != start+8*day+hour {
		t.Fatalf("只补一轮：%v %+v", queued, x)
	}
	// 暂停：到点也不动。
	ledger.Apply(ctx, env.DB, queued[1], ledger.Event{Kind: ledger.Cancel}, "u1", "")
	env.Pause.Set(ctx, dept, "u1")
	Tick(ctx, env, start+9*day, loc)
	if len(queued) != 2 {
		t.Fatal("暂停时不该生成")
	}
	// 手动 run：调研轮附上最近选项单没选的；上一轮没结束拒绝。
	env.Pause.Clear(ctx, dept)
	in := sample(3)
	in.Org = dept
	c, _ := AddChoice(ctx, env.DB, in, "", "u1")
	if _, err := Decide(ctx, env.DB, c.ID, nil, "不急", "u1"); err != nil {
		t.Fatal(err)
	}
	if run, err := RunNow(ctx, env, "s1", loc); err != nil || !strings.Contains(run.Detail, c.ID+"「下一步」没选：方向A、方向B、方向C（用户说明：不急）") {
		t.Fatalf("%+v %v", run, err)
	}
	if _, err := RunNow(ctx, env, "s1", loc); code(err) != "conflict" {
		t.Fatal("上一轮没结束，手动 run 应拒绝")
	}
	// 派活没接上：任务生成但报错。
	Enqueue = nil
	ledger.Apply(ctx, env.DB, queued[2], ledger.Event{Kind: ledger.Cancel}, "u1", "")
	if tk, err := RunNow(ctx, env, "s1", loc); err == nil || tk.ID == "" {
		t.Fatal("派活未接入应报错")
	}
	if _, err := RemoveSchedule(ctx, env.DB, "s1"); err != nil {
		t.Fatal(err)
	}
}
