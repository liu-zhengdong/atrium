package ledger

import "testing"

func TestDetailNeedsNames(t *testing.T) {
	for _, tc := range []struct {
		name string
		d    Detail
		want bool
	}{
		{"分派人", Detail{Parties: Parties{By: "a1"}}, true},
		{"处理人", Detail{Parties: Parties{Owner: "a10"}}, true},
		{"经历 actor", Detail{History: []TaskEvent{{Actor: "a99", Kind: "note"}}}, true},
		{"结构化 from", Detail{History: []TaskEvent{{Actor: "u1", Kind: "escalated", Body: `{"from":"a10"}`}}}, true},
		{"不扫描正文", Detail{Parties: Parties{By: "u1", Owner: "secretary"}, History: []TaskEvent{{Actor: "gates", Kind: "note", Body: "a1"}, {Actor: "a10x", Kind: "escalated", Body: "正文 a10"}}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := detailNeedsNames(tc.d); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestEscalationReporter(t *testing.T) {
	names := map[string]string{"a1": "Atrium 负责人", "a10": "命令行和网页负责人", "a2": "长名\n含（括号）<&>\""}
	for _, tc := range []struct {
		name, actor, kind, body, want string
	}{
		{"结构身份而非正文", "a10", "escalated", `{"from":"a1","label":"需要跨部门配合","note":"a10 原文","original":{"from":"a99"}}`, "Atrium 负责人（a1） · 需要跨部门配合"},
		{"完整键", "a1", "escalated", `{"from":"a10"}`, "命令行和网页负责人（a10）"},
		{"未知", "a1", "escalated", `{"from":"a99"}`, "未登记负责人（a99）"},
		{"长名", "a2", "escalated", "上报 a1：保留正文", "长名\n含（括号）<&>\"（a2）"},
		{"现行文本", "a10", "escalated", "上报 a1（需要跨部门配合）：a9 原文", "命令行和网页负责人（a10）"},
		{"不扫描正文", "gates", "escalated", `正文 {"from":"a1"}`, "gates"},
		{"坏结构不取半个字段", "worker", "escalated", `{"from":"a1","label":123}`, "worker"},
		{"没有上报人", "", "escalated", `{"note":"a1"}`, ""},
		{"非上报经历", "a1", "note", `{"from":"a10"}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := TaskEvent{Actor: tc.actor, Kind: tc.kind, Body: tc.body}
			if got := escalationReporter(e, names); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
			if text, err := historyText(e); err != nil || text != oneLine(tc.body) {
				t.Fatalf("经历正文被改写：%q %v", text, err)
			}
		})
	}
	for _, id := range []string{"u1", "secretary", "worker", "gates", "kimi@h3", "h1", "a0", "a10x", "a01"} {
		e := TaskEvent{Actor: id, Kind: "escalated"}
		if got := escalationReporter(e, names); got != id {
			t.Errorf("非负责人 %q 被改成 %q", id, got)
		}
	}
}
