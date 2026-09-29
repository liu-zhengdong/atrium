package secretary

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/platform"
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
	if got["env"].(map[string]any)[AsEnv] != "secretary" {
		t.Fatalf("应写 env.%s=secretary：%s", AsEnv, mustJSON(got))
	}
	if _, added, _ := WithHook(got); added {
		t.Fatal("已有 hook 与署名不应再改")
	}
	// 旧装法只有 hook：补上署名；env 里别的变量保留。
	got, added, err = WithHook(parse(`{"env":{"X":"1"},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"atrium secretary bridge --detach"}]}]}}`))
	if err != nil || !added || got["env"].(map[string]any)["X"] != "1" || got["env"].(map[string]any)[AsEnv] != "secretary" ||
		len(got["hooks"].(map[string]any)["SessionStart"].([]any)) != 1 {
		t.Fatalf("补署名：%s %v %v", mustJSON(got), added, err)
	}
	for _, bad := range []string{`{"hooks":[]}`, `{"hooks":{"SessionStart":{}}}`, `{"env":[]}`, `{"env":{"ATRIUM_AS":"u1"}}`} {
		if _, _, err := WithHook(parse(bad)); err == nil {
			t.Errorf("认不出的结构应报错：%s", bad)
		}
	}
}

func TestBridgeInWorker(t *testing.T) {
	tbl := cli.NewTable("atrium", "测试")
	Commands(tbl)
	worker := func(k string) string {
		return map[string]string{"ATRIUM_WORKER": "1", "ATRIUM_AS": "secretary"}[k]
	}
	for _, c := range []struct {
		args []string
		code int
	}{
		{[]string{"secretary", "bridge", "--detach"}, 0}, // SessionStart hook 在执行者会话里跑到：安静退出
		{[]string{"secretary", "bridge", "--status"}, 1},
		{[]string{"secretary", "bridge"}, 1},
	} {
		var out, errb bytes.Buffer
		code := tbl.Main(context.Background(), c.args, cli.Env{Stdout: &out, Stderr: &errb, Getenv: worker})
		if code != c.code || out.Len() != 0 || (code == 0) != (errb.Len() == 0) {
			t.Errorf("%v：退出码 %d，stdout %q，stderr %q", c.args, code, out.String(), errb.String())
		}
		if code != 0 && !strings.Contains(errb.String(), "执行者") {
			t.Errorf("%v 应按执行者拒绝：%q", c.args, errb.String())
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

func TestLiveness(t *testing.T) {
	gone := errors.Join(platform.ErrEndpointGone, errors.New("no such file"))
	busy := errors.New("connection refused")
	type probe struct {
		at  time.Duration // 距第一次探测
		err error
	}
	cases := []struct {
		name   string
		probes []probe
		exitAt int // 第几次探测后退出；-1 是一直不退出
	}{
		{"一直连得上", []probe{{0, nil}, {time.Minute, nil}, {10 * time.Minute, nil}}, -1},
		{"服务重启期间一次连不上不退出", []probe{{0, nil}, {5 * time.Second, busy}, {10 * time.Second, nil}}, -1},
		{"文件被删立即退出", []probe{{0, nil}, {5 * time.Second, gone}}, 1},
		{"一开始文件就不在立即退出", []probe{{0, gone}}, 0},
		{"一直连不上 2 分钟退出", []probe{{0, busy}, {time.Minute, busy}, {119 * time.Second, busy}, {2 * time.Minute, busy}}, 3},
		{"中间连上一次重新计时", []probe{{0, busy}, {90 * time.Second, nil}, {100 * time.Second, busy}, {200 * time.Second, busy}, {220 * time.Second, busy}}, 4},
		{"连不上一阵后文件被删立即退出", []probe{{0, busy}, {30 * time.Second, gone}}, 1},
	}
	start := time.Unix(1_800_000_000, 0)
	for _, tc := range cases {
		var l Liveness
		got := -1
		for i, p := range tc.probes {
			if reason := l.Observe(start.Add(p.at), p.err); reason != "" {
				got = i
				break
			}
		}
		if got != tc.exitAt {
			t.Errorf("%s：第 %d 次后退出，应为 %d", tc.name, got, tc.exitAt)
		}
	}
}

func TestBrief(t *testing.T) {
	v := watch.View{Choices: 2, Tasks: []watch.TaskRow{{ID: "t9", Title: "活", Holder: watch.Holder{Kind: "worker"}}}}
	points := []org.Point{{ID: "k32", Org: "o1", Text: "秘书只决定交给哪个部门", Why: "用户纠正过两次"}, {ID: "k27", Org: "o1", Text: "先求简洁"}}
	got := Brief(points, v, "规矩放哪")
	for _, want := range []string{"此刻全景", "在干活（1）", "t9", "选项单 2", "秘书备忘", "规矩放哪",
		"组织要点（靠前的优先）：\n- k32（o1）秘书只决定交给哪个部门——用户纠正过两次\n- k27（o1）先求简洁\n"} {
		if !strings.Contains(got, want) {
			t.Fatalf("Brief 缺 %q：\n%s", want, got)
		}
	}
	if !strings.HasPrefix(got, "组织要点") || strings.Index(got, "k27") > strings.Index(got, "此刻全景") {
		t.Fatalf("要点应在全景之前、按给的顺序：\n%s", got)
	}
	got = Brief(nil, watch.View{}, " \n")
	if !strings.HasSuffix(got, "（空）") {
		t.Fatalf("空备忘应写（空）：\n%s", got)
	}
	if strings.Contains(got, "组织要点") || !strings.HasPrefix(got, "此刻全景") {
		t.Fatalf("没有要点不出要点一节：\n%s", got)
	}
}
