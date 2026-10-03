package workers

// leaderRefusal 只补负责人首选的能力下限；费用/auto/风险沿用共同 Refusal。
func leaderRefusal(base, r Resolved, tried bool) string {
	if tried {
		return "这批事件已试过"
	}
	minTrust := max(TrustLevel("medium"), TrustLevel(base.Rules.EffectiveTrust()))
	if TrustLevel(r.Rules.EffectiveTrust()) < minTrust {
		return "信任低于负责人首选/medium"
	}
	return r.Rules.Refusal(base.Rules.EffectiveMaxRisk(), true)
}
