package web

import "regexp"

var leaderKey = regexp.MustCompile(`^a[1-9][0-9]*$`)

// identityText 只呈现完整身份键，不解析正文；名册保持原有名字语义。
func identityText(id string, names map[string]string) string {
	name := names[id]
	if leaderKey.MatchString(id) {
		if name == "" {
			name = "未登记负责人"
		}
		return name + "（" + id + "）"
	}
	if name != "" {
		return name
	}
	return id
}
