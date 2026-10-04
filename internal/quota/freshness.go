package quota

const staleAfter = 10 * 60_000 // 超过 10 分钟的感知读数算旧数

func clampPct(v float64) float64 { return min(100, max(0, v)) }
