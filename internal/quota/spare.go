package quota

import "fmt"

// Stored 是 quota_cache 的一行：某台机器对某个 provider 的来源读数；不证明当前执行账号或共享池。
type Stored struct {
	Host string `json:"host"`
	Reading
}

// Accounts 是旧厂商读取与缓存接受的来源名，不证明执行账号或共享池。
var Accounts = []string{"claude", "codex", "opencode", "kimi", "grok", "cursor", "antigravity"}

// Spare 是给分派任务的一个账号的额度判定。
type Spare struct {
	TokenWindows []TokenWindow `json:"token_windows,omitempty"`
	Account      string        `json:"account"`
	// Percent 是富余：周期已过 − 已用；零用量且缺周期进度按 0，其他算不出为空。分派任务按它排先后。
	Percent *float64 `json:"percent,omitempty"`
	Stale   bool     `json:"stale"` // 读数超过 10 分钟
	// Stop 是不该再派的原因：已用到给用户留的份额（周窗与短窗取紧的）；能派为空。
	Stop string `json:"stop,omitempty"`
}

// TokenWindow 仅由明确同池同窗 token 分母证据消费得出，不持久化差值。
type TokenWindow struct {
	ID        string  `json:"id"`
	Total     float64 `json:"total"`
	Used      float64 `json:"used"`
	Remaining float64 `json:"remaining"`
	Available float64 `json:"available"`
}

// WithDemand 对本轮任务声明量逐窗判容纳，0 表示未知，不从任务文本估算。
// 选择与启动共用此入口；先保留百分比/marks 等既有拒绝原因。
func (s Spare) WithDemand(tokens int64) Spare {
	if s.Stop != "" || tokens <= 0 {
		return s
	}
	for _, w := range s.TokenWindows {
		if float64(tokens) > w.Available {
			s.Stop = fmt.Sprintf("token 容量不足：窗口 %s 可派 %.0f，任务需要 %d", w.ID, w.Available, tokens)
			break
		}
	}
	return s
}
