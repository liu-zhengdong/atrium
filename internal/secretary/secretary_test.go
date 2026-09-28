package secretary

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/watch"
)

func row(id, updated int64, task string) events.Row {
	body, _ := json.Marshal(map[string]any{"from": "running", "to": "blocked", "title": "活" + task})
	return events.Row{ID: id, UpdatedAt: updated, Task: task, Kind: events.TaskStatus, Count: 1, Body: body}
}

func TestPlanBatch(t *testing.T) {
	remind := 30 * time.Minute
	now := int64(100 * 60000)
	sent := Sent{1: {UpdatedAt: 10, SentAt: now - 10*60000}, 2: {UpdatedAt: 10, SentAt: now - 31*60000}, 3: {UpdatedAt: 10, SentAt: now}}
	acked := row(5, 1, "t5")
	acked.AckedAt = &now
	b := PlanBatch(sent, []events.Row{row(1, 10, "t1"), row(2, 10, "t2"), row(3, 11, "t3"), row(4, 1, "t4"), acked}, now, remind)
	ids := func(rs []events.Row) (out []int64) {
		for _, r := range rs {
			out = append(out, r.ID)
		}
		return
	}
	if f, r := ids(b.Fresh), ids(b.Remind); len(f) != 2 || f[0] != 3 || f[1] != 4 || len(r) != 1 || r[0] != 2 {
		t.Fatalf("fresh=%v remind=%v（1 送过不久略过，2 满 30 分钟再提醒，3 合并了新情况，4 新的，5 已确认）", f, r)
	}
	if PlanBatch(sent, nil, now, remind).Empty() != true {
		t.Fatal("空批应为空")
	}
	sent.Record(b.Fresh, now)
	if sent[3].UpdatedAt != 11 || sent[4].SentAt != now {
		t.Fatalf("Record: %+v", sent)
	}
}

func TestMerge(t *testing.T) {
	got := Merge([]events.Row{row(1, 1, "t1")}, []events.Row{row(1, 2, "t1"), row(2, 1, "t2")})
	if len(got) != 2 || got[0].UpdatedAt != 2 {
		t.Fatalf("Merge: %+v", got)
	}
}

func TestPromptAndInbox(t *testing.T) {
	p := Prompt(Batch{Fresh: []events.Row{row(7, 1, "t3")}, Remind: []events.Row{row(4, 1, "t1")}}, 30*time.Minute)
	for _, want := range []string{"【Atrium 事件】1 条要处理：", "- #7 t3 running → blocked「活t3」", "送过 30 分钟还没确认：",
		"看详情：atrium task show t3；atrium task show t1", "处理完确认：atrium events ack 7 4"} {
		if !strings.Contains(p, want) {
			t.Errorf("消息缺「%s」：\n%s", want, p)
		}
	}
	if !strings.HasPrefix(p, "【Atrium 事件】") {
		t.Errorf("消息应以「【Atrium 事件】」开头：%s", p)
	}
	only := Prompt(Batch{Remind: []events.Row{row(4, 1, "")}}, 30*time.Minute)
	if !strings.HasPrefix(only, "【Atrium 事件】提醒：1 条送过 30 分钟还没确认：") || strings.Contains(only, "看详情") {
		t.Errorf("只有提醒：%s", only)
	}
	lines := InboxLines("tok", "你好\n世界")
	if len(lines) != 2 || lines[0] != `{"type":"auth","token":"tok"}` ||
		lines[1] != `{"type":"user","message":{"role":"user","content":"你好\n世界"}}` {
		t.Errorf("InboxLines = %q", lines)
	}
}

func TestClaim(t *testing.T) {
	alive := func(pid int) bool { return pid == 1 }
	cases := []struct {
		cur  *Record
		want string
	}{
		{nil, "start"},
		{&Record{PID: 2, Socket: "/s"}, "start"},
		{&Record{PID: 1, Socket: "/s"}, "running"},
		{&Record{PID: 1, Socket: "/other"}, "takeover"},
	}
	for _, c := range cases {
		if got := Claim(c.cur, "/s", alive); got != c.want {
			t.Errorf("Claim(%+v) = %s，应为 %s", c.cur, got, c.want)
		}
	}
}

func TestWithHook(t *testing.T) {
	parse := func(s string) map[string]any {
		var m map[string]any
		if err := json.Unmarshal([]byte(s), &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	got, added, err := WithHook(nil)
	if err != nil || !added || !strings.Contains(mustJSON(got), HookCommand) {
		t.Fatalf("空设置：%v %v %v", got, added, err)
	}
	got, added, err = WithHook(parse(`{"model":"x","hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo hi"}]}],"Stop":[]}}`))
	if err != nil || !added || got["model"] != "x" || len(got["hooks"].(map[string]any)["SessionStart"].([]any)) != 2 ||
		got["hooks"].(map[string]any)["Stop"] == nil {
		t.Fatalf("保留原有：%s %v %v", mustJSON(got), added, err)
	}
	if _, added, _ := WithHook(got); added {
		t.Fatal("已有 hook 不应再加")
	}
	for _, bad := range []string{`{"hooks":[]}`, `{"hooks":{"SessionStart":{}}}`} {
		if _, _, err := WithHook(parse(bad)); err == nil {
			t.Errorf("认不出的结构应报错：%s", bad)
		}
	}
}

func mustJSON(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}

var ansi = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func TestStatusLine(t *testing.T) {
	now := int64(100 * 60000)
	v := watch.View{At: now, Choices: 2, Queued: 1, Tasks: []watch.TaskRow{
		{ID: "t1", Holder: watch.Holder{Kind: "worker", Who: "codex+gpt:high", Since: now - 12*60000}},
		{ID: "t2", Holder: watch.Holder{Kind: "leader", Who: "a1", Text: "卡住，等处理"}, Overdue: 1},
		{ID: "t3", Holder: watch.Holder{Kind: "runtime", Who: "运行时", Text: "排队等执行者"}},
	}}
	got := ansi.ReplaceAllString(StatusLine(v), "")
	if want := "等你拍板 2 · t2 a1 卡住，等处理 · t1 codex 12 分钟 · 排队 1 · 秘书不在听"; got != want {
		t.Errorf("StatusLine =\n%s\n应为\n%s", got, want)
	}
	v = watch.View{At: now, Secretary: watch.SecretaryView{Red: true, Pending: 3}}
	if got := ansi.ReplaceAllString(StatusLine(v), ""); got != "没有在做的事 · 秘书没在听（3 条事件）" {
		t.Errorf("空：%s", got)
	}
	for i := 0; i < 6; i++ {
		v.Tasks = append(v.Tasks, watch.TaskRow{ID: "t9", Holder: watch.Holder{Kind: "worker"}})
	}
	if got := ansi.ReplaceAllString(StatusLine(v), ""); !strings.Contains(got, "另 2 件") {
		t.Errorf("多了应折叠：%s", got)
	}
}
