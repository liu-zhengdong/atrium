package org

// DisplayIdentity 按名册精确呈现完整负责人键；其他结构身份键原样返回。
// names 由 identities 名册读取，调用方不应从正文或历史记录推断名字。
// 返回纯文本；HTML 转义与换行布局由呈现端负责。
func DisplayIdentity(id string, names map[string]string) string {
	if len(id) < 2 || id[0] != 'a' || id[1] < '1' || id[1] > '9' {
		return id
	}
	for i := 2; i < len(id); i++ {
		if id[i] < '0' || id[i] > '9' {
			return id
		}
	}
	name, ok := names[id]
	if !ok {
		name = "未登记负责人"
	}
	return name + "（" + id + "）"
}
