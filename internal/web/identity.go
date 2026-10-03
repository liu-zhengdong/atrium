package web

import "github.com/liu-zhengdong/atrium/internal/org"

// identityText 保留非负责人名字语义；负责人规则由 org 单独维护。
func identityText(id string, names map[string]string) string {
	if text := org.DisplayIdentity(id, names); text != id {
		return text
	}
	if name := names[id]; name != "" {
		return name
	}
	return id
}

// identityLabels 只呈现当前名册；任务的未登记身份由任务投影直接呈现。
func identityLabels(names map[string]string) map[string]string {
	labels := make(map[string]string, len(names))
	for id := range names {
		labels[id] = identityText(id, names)
	}
	return labels
}
