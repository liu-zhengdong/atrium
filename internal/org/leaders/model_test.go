package leaders

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/org"
)

func TestDue(t *testing.T) {
	now := int64(100_000)
	pending := []Pending{
		{Leader: "a1", Oldest: now - 31_000, IDs: []int64{1}}, // 等满
		{Leader: "a2", Oldest: now - 5_000, IDs: []int64{2}},  // 还在攒
		{Leader: "a3", Oldest: now - 60_000, IDs: []int64{3}}, // 在跑
		{Leader: "a4", Oldest: now - 30_000, IDs: []int64{4}}, // 正好 30 秒
		{Leader: "a5", Oldest: 0},                             // 没事件
	}
	got := Due(pending, map[string]bool{"a3": true}, now, 30*time.Second)
	var ids []string
	for _, p := range got {
		ids = append(ids, p.Leader)
	}
	if !reflect.DeepEqual(ids, []string{"a1", "a4"}) {
		t.Fatalf("%v", ids)
	}
}

func TestOutcome(t *testing.T) {
	cases := []struct {
		left, fails, next int
		forward           bool
	}{
		{0, 0, 0, false}, // 全确认
		{0, 1, 0, false}, // 成功清零
		{2, 0, 1, false}, // 第一次失败
		{2, 1, 0, true},  // 连续第二次：转交并清零
	}
	for _, c := range cases {
		next, fwd := Outcome(c.left, c.fails)
		if next != c.next || fwd != c.forward {
			t.Errorf("Outcome(%d,%d) = %d,%v", c.left, c.fails, next, fwd)
		}
	}
	if PickWorker(nil, 0) != "" || PickWorker([]string{"a", "b"}, 1) != "b" || PickWorker([]string{"a", "b"}, 2) != "a" {
		t.Error("PickWorker 轮换不对")
	}
}

func TestUpstream(t *testing.T) {
	ps := map[string]string{"o1": "", "o2": "o1", "o3": "o2", "o4": ""}
	ls := map[string]string{"o1": "a1", "o3": "a2", "o4": "a2"}
	cases := []struct{ who, dept, want string }{
		{"a2", "", "a1"},          // 没给部门：用它负责的第一个（o3）往上
		{"a2", "o4", "secretary"}, // 按事件的部门往上
		{"a1", "", "secretary"},
		{"a9", "", "secretary"},
		{"a1", "o3", "secretary"}, // 下层转交来的：从 a1 那一层往上
		{"a2", "o9", "a1"},        // 部门不在链上：用它负责的第一个
		{"a2", "o3", "a1"},
	}
	for _, c := range cases {
		if got := Upstream(ps, ls, c.who, c.dept); got != c.want {
			t.Errorf("Upstream(%s,%s)=%s 应为 %s", c.who, c.dept, got, c.want)
		}
	}
}

func TestRuleFor(t *testing.T) {
	cases := map[string]Rule{
		"GET /api/tasks/{id}":               RuleRead,
		"GET /api/org":                      RuleRead,
		"GET /api/service/status":           RuleDeny,
		"POST /api/service/stop":            RuleDeny,
		"POST /api/auth/rotate":             RuleDeny,
		"GET /health":                       RuleDeny,
		"POST /api/tasks":                   RuleTaskCreate,
		"PATCH /api/tasks/{id}":             RuleTaskRef,
		"POST /api/tasks/{id}/notes":        RuleTaskRef,
		"POST /api/tasks/{id}/run":          RuleTaskRef,
		"POST /api/org":                     RuleDeny,
		"PATCH /api/org/{id}":               RuleDeptIntro,
		"POST /api/org/{id}/points":         RuleDeptRef,
		"POST /api/org/{id}/materials":      RuleDeptRef,
		"PATCH /api/points/{id}":            RulePointRef,
		"POST /api/materials":               RuleBodyDept,
		"POST /api/materials/{id}/archive":  RuleMaterialRef,
		"POST /api/schedules":               RuleBodyDept,
		"DELETE /api/schedules/{id}":        RuleScheduleRef,
		"PUT /api/memo":                     RuleMemo,
		"POST /api/events/ack":              RuleEventsAck,
		"POST /api/escalations":             RuleEscalate,
		"POST /api/leaders":                 RuleDeny,
		"PATCH /api/leaders/{id}":           RuleDeny,
		"POST /api/pause":                   RuleDeny,
		"POST /api/choices/{id}/pick":       RuleDeny,
		"PUT /api/secrets/{org}/{name}":     RuleDeny,
		"POST /api/hosts":                   RuleDeny,
		"POST /api/tasks/{id}/merge/ignore": RuleTaskRef,
	}
	for p, want := range cases {
		if got := RuleFor(p); got != want {
			t.Errorf("RuleFor(%q) = %d，应为 %d", p, got, want)
		}
	}
}

func TestIntroOnly(t *testing.T) {
	cases := []struct {
		body map[string]any
		ok   bool
	}{
		{map[string]any{"next": "x"}, true},
		{map[string]any{"what": "x", "uses": "y", "now": "z", "next": "w"}, true},
		{map[string]any{}, true}, // 空请求体由处理函数报「没有要改的字段」
		{map[string]any{"next": "x", "name": "改名"}, false},
		{map[string]any{"leader": "a1"}, false},
		{map[string]any{"parent": "o1"}, false},
		{map[string]any{"accept": "auto"}, false},
		{map[string]any{"repo_add": []any{"r"}}, false},
		{map[string]any{"repo_rm": []any{"r"}}, false},
		{map[string]any{"delete": true}, false},
		{map[string]any{"delete": false}, false}, // 按键名判，不看值
		{map[string]any{"name": ""}, false},
		{map[string]any{"Leader": "a1"}, false}, // 解码不分大小写，键名要逐字相同
		{map[string]any{"NEXT": "x"}, false},
	}
	for _, c := range cases {
		err := IntroOnly(c.body)
		if (err == nil) != c.ok {
			t.Errorf("%v：%v", c.body, err)
		}
		var ae *api.Error
		if err != nil && (!errors.As(err, &ae) || ae.Status != 403 || !strings.Contains(ae.Message, "只归秘书和用户")) {
			t.Errorf("%v：拒绝要 403 且说明只归秘书和用户：%v", c.body, err)
		}
	}
}

func TestInScope(t *testing.T) {
	scope := map[string]bool{"o2": true, "o3": true}
	if InScope("a1", scope, []Check{{"任务 t1", "o2"}, {"部门 o3", "o3"}}) != nil {
		t.Error("都在管辖内应放行")
	}
	for _, checks := range [][]Check{{{"任务 t1", "o1"}}, {{"任务 t1", ""}}, {{"任务 t1", "o2"}, {"部门 o4", "o4"}}} {
		err := InScope("a1", scope, checks)
		if err == nil || err.(interface{ Error() string }).Error() == "" {
			t.Errorf("%v 应拒绝", checks)
			continue
		}
		if e := Forbid("x"); e.Status != 403 || !strings.Contains(e.Next, "leader escalate") {
			t.Error("越权要 403 且提示上交")
		}
	}
}

func TestCheckEscalate(t *testing.T) {
	cases := []struct {
		in EscalateIn
		ok bool
	}{
		{EscalateIn{Kind: "stuck", Note: "卡住了"}, true},
		{EscalateIn{Kind: "cross", Note: "要 o5 配合", Task: "t3"}, true},
		{EscalateIn{Kind: "shipped", Note: "上线", Task: "t3"}, true},
		{EscalateIn{Kind: "shipped", Note: "上线", Event: 7}, true}, // 转交下层的，任务取原事件
		{EscalateIn{Kind: "shipped", Note: "上线"}, false},
		{EscalateIn{Kind: "other", Note: "x"}, false},
		{EscalateIn{Kind: "stuck", Note: "  "}, false},
		{EscalateIn{Kind: "stuck", Note: "x", Task: "o3"}, false},
		{EscalateIn{Kind: "stuck", Note: strings.Repeat("字", maxNote+1)}, false},
	}
	for _, c := range cases {
		if err := CheckEscalate(c.in); (err == nil) != c.ok {
			t.Errorf("%+v: %v", c.in, err)
		}
	}
}

func TestPrompt(t *testing.T) {
	in := PromptInput{
		Leader: org.Identity{ID: "a2", Name: "运行时"},
		Depts: []DeptBrief{{Dept: org.Dept{ID: "o3", Name: "服务", What: "单实例后台服务", Now: "在迁 Go"},
			Path: []string{"o1", "o2", "o3"}, Chain: []org.Point{{ID: "k1", Org: "o1", Text: "简洁优先", Why: "长期成本"}},
			Materials: "总览正文", Covered: []org.Dept{{ID: "o22", Name: "网页"}, {ID: "o23", Name: "导入"}}}},
		Memo:     "等 t5 合入",
		Events:   []Event{{ID: 11, Kind: "task.status", Task: "t5", Dept: "o3", Body: `{"to":"blocked"}`}, {ID: 12, Kind: "overdue"}},
		Upstream: "a1",
	}
	p := Prompt(in)
	for _, want := range []string{"负责人 a2（运行时）", "o3 服务（o1 / o2 / o3）", "是什么：单实例后台服务", "k1（o1）简洁优先——长期成本",
		"总览正文", "也归你管的下属部门：o22 网页、o23 导入", "等 t5 合入", "#11", "t5（o3）", "atrium events ack 11 12", "投给 a1", "--kind shipped", "--kind stuck", "权限边界"} {
		if !strings.Contains(p, want) {
			t.Errorf("提示词缺 %q", want)
		}
	}
	if strings.Contains(p, "交给你去拆的任务") {
		t.Error("没有 task.assigned 不附拆活做法")
	}
	in.Events = append(in.Events, Event{ID: 13, Kind: "task.assigned", Task: "t6", Dept: "o3"})
	if p := Prompt(in); !strings.Contains(p, "交给你去拆的任务") || !strings.Contains(p, "--parent tN") {
		t.Error("有 task.assigned 要附拆活做法")
	}
	if !strings.Contains(Prompt(PromptInput{Leader: org.Identity{ID: "a3"}, Upstream: "secretary"}), "（空）") {
		t.Error("空备忘要写（空）")
	}
}
