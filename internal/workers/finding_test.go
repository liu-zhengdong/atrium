package workers

import (
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/ledger"
)

func TestParseFinding(t *testing.T) {
	task := ledger.Task{ID: "t476", Title: "改帮助中心", Org: "o9"}
	tr := Trace{Unknown: 8, UnknownHead: []string{`{"type":"interaction_query","subtype":"request"}`, `{"type":"interaction_query","subtype":"response"}`}}
	cursorOpen := []ledger.Task{{ID: "t500", Title: "cursor 日志有认不出的事件（t470）"}}
	cases := []struct {
		name string
		tr   Trace
		open []ledger.Task
		want bool
	}{
		{"都认出了", Trace{}, nil, false},
		{"有认不出的", tr, nil, true},
		{"同一工具已有没结束的", tr, cursorOpen, false},
		{"别的工具的不算", tr, []ledger.Task{{Title: "codex 日志有认不出的事件（t1）"}}, true},
		{"名字只是前缀的工具不算", tr, []ledger.Task{{Title: "cursorx 日志有认不出的事件（t1）"}}, true},
	}
	for _, c := range cases {
		got, ok := ParseFinding(task, "cursor+auto:high", c.tr, c.open)
		if ok != c.want {
			t.Errorf("%s：记 %v，应为 %v", c.name, ok, c.want)
			continue
		}
		if !ok {
			continue
		}
		if got.Title != "cursor 日志有认不出的事件（t476）" || got.Org != "o9" || !got.Draft || got.Source != ledger.SourceOrg || got.Class != ParseClass ||
			!strings.Contains(got.Detail, "cursor+auto:high 日志里有 8 行事件认不出") || !strings.Contains(got.Detail, `"subtype":"response"}`) {
			t.Errorf("%s：%+v", c.name, got)
		}
	}
}
