package secretary

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

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
	p := Prompt(Batch{Fresh: []events.Row{row(7, 1, "t3")}, Remind: []events.Row{row(4, 1, "t1")}}, 0, 30*time.Minute)
	for _, want := range []string{"【Atrium 事件】1 条要处理：", "- #7 t3 running → blocked「活t3」", "送过 30 分钟还没确认：",
		"看详情：atrium task show t3；atrium task show t1", "处理完确认：atrium events ack 7 4"} {
		if !strings.Contains(p, want) {
			t.Errorf("消息缺「%s」：\n%s", want, p)
		}
	}
	if !strings.HasPrefix(p, "【Atrium 事件】") {
		t.Errorf("消息应以「【Atrium 事件】」开头：%s", p)
	}
	only := Prompt(Batch{Remind: []events.Row{row(4, 1, "")}}, 0, 30*time.Minute)
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
	got := Brief("", "", points, v, "规矩放哪")
	for _, want := range []string{"此刻全景", "在干活（1）", "t9", "选项单 2", "秘书备忘", "规矩放哪",
		"组织要点（靠前的优先）：\n- k32（o1）秘书只决定交给哪个部门——用户纠正过两次\n- k27（o1）先求简洁\n"} {
		if !strings.Contains(got, want) {
			t.Fatalf("Brief 缺 %q：\n%s", want, got)
		}
	}
	if !strings.HasPrefix(got, "组织要点") || strings.Index(got, "k27") > strings.Index(got, "此刻全景") {
		t.Fatalf("要点应在全景之前、按给的顺序：\n%s", got)
	}
	got = Brief("", "", nil, watch.View{}, " \n")
	if !strings.HasSuffix(got, "（空）") {
		t.Fatalf("空备忘应写（空）：\n%s", got)
	}
	if strings.Contains(got, "组织要点") || !strings.HasPrefix(got, "此刻全景") {
		t.Fatalf("没有要点不出要点一节：\n%s", got)
	}
	// 全局原则排在最前，技能索引、要点依次在它之后。
	got = Brief("## 用户的全局原则\n\n先给结论\n", "## 技能索引（Atrium 全部技能）\n\n- web：网页\n", points, v, "")
	if !strings.HasPrefix(got, "## 用户的全局原则\n\n先给结论\n\n## 技能索引（Atrium 全部技能）\n\n- web：网页\n\n组织要点") {
		t.Fatalf("全局原则、技能索引应在要点之前：\n%s", got)
	}
}

// notify 沿用现有 bridge，但转告语义必须出现在实际注入消息里。
func TestNotifyPrompt(t *testing.T) {
	p := Prompt(Batch{Fresh: []events.Row{{ID: 9, Kind: events.LeaderEscalate, Body: json.RawMessage(`{"from":"a2","kind":"notify","note":"将调整应用配置"}`)}}}, 0, 30*time.Minute)
	for _, want := range []string{"a2 知会用户", "将调整应用配置", "秘书转告用户后确认", "不需回复或拍板", "负责人继续派活", "atrium events ack 9"} {
		if !strings.Contains(p, want) {
			t.Fatalf("知会消息缺 %s：%s", want, p)
		}
	}
}

// MatchPiInbox：pid、名字、会话 id 前缀三种挑法，对不上与对上多个都要说清楚。
func TestMatchPiInbox(t *testing.T) {
	list := []platform.PiInbox{
		{PID: 41, SessionID: "aaaa1111-2222", Name: "秘书", Cwd: "/repo/atrium"},
		{PID: 42, SessionID: "bbbb3333-4444", Cwd: "/repo"},
		{PID: 43, SessionID: "bbbb5555-6666", Cwd: "/tmp"},
	}
	if in, err := MatchPiInbox(list, "41"); err != nil || in.PID != 41 {
		t.Fatalf("按 pid 挑：%v %+v", err, in)
	}
	if in, err := MatchPiInbox(list, "秘书"); err != nil || in.PID != 41 {
		t.Fatalf("按名字挑：%v %+v", err, in)
	}
	if in, err := MatchPiInbox(list, "aaaa"); err != nil || in.PID != 41 {
		t.Fatalf("按会话 id 前缀挑：%v %+v", err, in)
	}
	if _, err := MatchPiInbox(list, "9999"); err == nil || !strings.Contains(err.Error(), "没有这个 Pi 会话") {
		t.Fatalf("对不上应报错并列出在登记的会话：%v", err)
	}
	_, err := MatchPiInbox(list, "bbbb")
	if err == nil || !strings.Contains(err.Error(), "42") || !strings.Contains(err.Error(), "43") {
		t.Fatalf("对上多个应报出候选：%v", err)
	}
}

// sessionInbox：Pi 的收件地址优先（扩展起的 bridge 带着它），其次 Claude Code 的，都没有就报错。
func TestSessionInbox(t *testing.T) {
	pi := func(k string) string {
		return map[string]string{piInboxEnv: "/tmp/pi.sock", piTokenEnv: "t-pi"}[k]
	}
	in, err := sessionInbox("linux", pi)
	if err != nil || in.kind != kindPi || in.endpoint != "/tmp/pi.sock" || in.token != "t-pi" {
		t.Fatalf("Pi 环境：%v %+v", err, in)
	}
	cc := func(k string) string {
		return map[string]string{"CLAUDE_CODE_MESSAGING_SOCKET": "uds:/tmp/cc.sock", "CLAUDE_CODE_MESSAGING_TOKEN": "t-cc"}[k]
	}
	in, err = sessionInbox("linux", cc)
	if err != nil || in.kind != kindClaude || in.endpoint != "/tmp/cc.sock" || in.token != "t-cc" {
		t.Fatalf("Claude Code 环境：%v %+v", err, in)
	}
	if _, err := sessionInbox("linux", func(string) string { return "" }); err == nil || !strings.Contains(err.Error(), piInboxEnv) {
		t.Fatalf("不在会话里应报错并提示 /secretary on：%v", err)
	}
	bad := func(k string) string {
		return map[string]string{"CLAUDE_CODE_MESSAGING_SOCKET": "不是路径", "CLAUDE_CODE_MESSAGING_TOKEN": "t"}[k]
	}
	if _, err := sessionInbox("linux", bad); err == nil || !strings.Contains(err.Error(), "认不出") {
		t.Fatalf("收件地址认不出应报错：%v", err)
	}
}

func TestStatusText(t *testing.T) {
	failed := &Record{PID: 42, Kind: kindPi, Failure: "会话没收下：unauthorized", FailedAt: time.Date(2026, 10, 3, 9, 56, 1, 0, time.Local).UnixMilli()}
	ok := &Record{PID: 42, Kind: kindPi}
	l := &events.Listener{Via: "Pi 会话，经注入"}
	cases := []struct {
		name  string
		cur   *Record
		alive bool
		l     *events.Listener
		want  []string
		not   string
	}{
		{"在重试：失败压过在听", failed, true, l, []string{"最近一次投递失败（10-03 09:56:01）", "unauthorized", "在重试"}, "秘书在听"},
		{"已退出：留着失败", failed, false, nil, []string{"bridge 已退出（pid 42，Pi 会话）", "10-03 09:56:01", "unauthorized"}, "在重试"},
		{"送成功：正常", ok, true, l, []string{"秘书在听（Pi 会话，经注入）", "bridge pid 42"}, "失败"},
		{"进程没了且没失败：当没有", ok, false, nil, []string{"没有 bridge 在听"}, "pid 42"},
		{"在跑没报在听", ok, true, nil, []string{"bridge 在跑（pid 42）"}, "失败"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			text, _ := statusText(c.cur, c.alive, c.l, "bridge.log")
			for _, w := range c.want {
				if !strings.Contains(text, w) {
					t.Errorf("应含 %q：%s", w, text)
				}
			}
			if strings.Contains(text, c.not) {
				t.Errorf("不应含 %q：%s", c.not, text)
			}
		})
	}
}
