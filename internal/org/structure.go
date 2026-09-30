package org

import (
	"maps"
	"slices"

	"github.com/liu-zhengdong/atrium/internal/api"
)

// SubordinateScope 是 who 管辖内、最近负责人却是别人的部门。秘书管没有负责人的顶层。
func SubordinateScope(parents, leaders map[string]string, who string) map[string]bool {
	owned := Scope(parents, leaders, who)
	if who == Secretary {
		owned = parentsToScope(parents)
	}
	out := map[string]bool{}
	for d := range owned {
		nearest, _ := Nearest(parents, leaders, d, "")
		if nearest != who && nearest != Secretary {
			out[d] = true
		}
	}
	return out
}

func parentsToScope(parents map[string]string) map[string]bool {
	out := make(map[string]bool, len(parents))
	for d := range parents {
		out[d] = true
	}
	return out
}

// DirectReports 按最近的上一层负责人计数；同一位下属管几个部门只算一位。
func DirectReports(parents, leaders map[string]string) map[string]int {
	sets := map[string]map[string]bool{}
	for d, child := range leaders {
		upper, _ := Nearest(parents, leaders, parents[d], child)
		if sets[upper] == nil {
			sets[upper] = map[string]bool{}
		}
		sets[upper][child] = true
	}
	out := map[string]int{}
	for upper, children := range sets {
		out[upper] = len(children)
	}
	return out
}

// CheckDirectReports 用变更后的两张映射判所有上一层的上限。
func CheckDirectReports(parents, leaders map[string]string) error {
	counts := DirectReports(parents, leaders)
	for _, upper := range slices.Sorted(maps.Keys(counts)) {
		if counts[upper] > MaxDirectLeaders {
			return api.Limit("atrium leader ls", "负责人 %s 的直接下属负责人将有 %d/%d 位：%s",
				upper, counts[upper], MaxDirectLeaders, LimitOf("direct_leaders").Fix)
		}
	}
	return nil
}

// SubordinateForbidden 给结构变更的越权回执统一指向上一层。
func SubordinateForbidden(dept string) error {
	return api.Forbidden("部门 %s 不在你的下属负责人区域；自己直接管的地方改结构要交上一层", dept).
		WithNext("atrium leader escalate <要建什么、为什么> --kind beyond")
}
