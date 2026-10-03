package workers

import "strings"

// Silent 纯判定：只有完整的四类零读数，且没有可识别动作、回复或未知输出，
// 才能认定静默空转。缺 usage、零金额、只有输入/输出为零都不足以判定。
// delivered 由调用方传入已核实的交付/状态动作；不依赖模型自述。
func Silent(t Trace, delivered bool) bool {
	if delivered || !t.Ended || t.Unknown > 0 || strings.TrimSpace(t.Result) != "" || len(t.Lines) > 0 {
		return false
	}
	for _, n := range []*int64{t.Usage.Input, t.Usage.Output, t.Usage.CacheRead, t.Usage.CacheWrite} {
		if n == nil || *n != 0 {
			return false
		}
	}
	for _, s := range t.Segments {
		if strings.TrimSpace(s.Say) != "" || len(s.Cmds) > 0 {
			return false
		}
	}
	return true
}
