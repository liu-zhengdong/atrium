package workers

import (
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/ledger"
)

// ParseClass 是日志有认不出的事件时自动记的草稿的类。
const ParseClass = "执行者日志解析"

// ParseFinding 纯判定：一次拉起的日志有认不出的事件（工具升级改了日志格式），要自动记的那条「组织发现」草稿。
// open 是这一类还没结束的任务：同一工具已有一条（标题以「工具 」开头）就不再记，解析跟上之前一条就够。
func ParseFinding(t ledger.Task, worker string, tr Trace, open []ledger.Task) (ledger.NewTask, bool) {
	if tr.Unknown == 0 {
		return ledger.NewTask{}, false
	}
	s, _ := ParseWorker(worker)
	for _, o := range open {
		if strings.HasPrefix(o.Title, s.Tool+" ") {
			return ledger.NewTask{}, false
		}
	}
	return ledger.NewTask{
		Title: fmt.Sprintf("%s 日志有认不出的事件（%s）", s.Tool, t.ID),
		Detail: fmt.Sprintf("%s「%s」的执行者 %s 日志里有 %d 行事件认不出：工具的日志格式可能变了，"+
			"经过里看不到它们。要在 internal/workers/tracers.go 里认出（该显示就显示，噪音就认出不显示），真实样本进 testdata。\n"+
			"前几行原文：\n%s", t.ID, t.Title, worker, tr.Unknown, strings.Join(tr.UnknownHead, "\n")),
		Org:    t.Org,
		Draft:  true,
		Source: ledger.SourceOrg,
		Class:  ParseClass,
	}, true
}
