// Package gates（桩，第二波实现）：验收关卡：运行时自己查事实（PR、提交、改动规模、CI、评论），按档案 checks 判过或不过；不采信执行者自述。低信任或高风险另派不同模型审阅。
//
// 命令（第二波）：task deliver。
// 结论经 ledger.Apply(GatePass / ReviewPass / Bounce) 落账，理由用 ledger.Record(kind "gate"/"review") 记进经历。
// 契约见 internal/README.md。
package gates

import "github.com/liu-zhengdong/atrium/internal/app"

// Module 是本包接入点。第二波在这里填 Commands、Routes、Run；cmd/atrium 已把它排进模块列表。
func Module() app.Module { return app.Module{Name: "gates"} }

// Facts 是运行时查到的事实（不来自执行者自述）。
type Facts struct {
	PR           string
	HeadCommit   string
	ChangedLines int
	Finished     bool
}

// Verdict 是关卡结论；Reasons 给人看，也原样交回执行者。
type Verdict struct {
	Pass    bool
	Reasons []string
}
