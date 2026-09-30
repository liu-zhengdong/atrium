package workers

import "fmt"

// EffectiveAuto：没写时参与自动挑人。
func (r Rules) EffectiveAuto() bool { return r.Auto == nil || *r.Auto }

// Refusal 判定档案是否接受本次分派任务；点名仅检查风险。纯函数。
func (r Rules) Refusal(risk string, automatic bool) string {
	if automatic && !r.EffectiveAuto() {
		return "档案 auto=false：只接点名分派任务"
	}
	if max := r.EffectiveMaxRisk(); RiskLevel(max) < RiskLevel(risk) {
		why := "档案 max_risk=" + max
		if r.MaxRisk == "" {
			why = fmt.Sprintf("档案没写 max_risk，trust=%s 只接到 %s", r.EffectiveTrust(), max)
		}
		return fmt.Sprintf("%s，低于任务 risk=%s", why, risk)
	}
	return ""
}
