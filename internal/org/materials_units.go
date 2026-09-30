package org

import (
	"path"
	"strings"
	"unicode/utf8"
)

// Units 纯函数：图片扩展名（复用 imageExts）不折算字数；其余文本（合法 UTF-8、无 NUL）按字（rune）数。
// 图片与非文本内容字数记 0，另按字节数计入二进制总量。
func Units(name string, content []byte) (units int, binary bool) {
	if !imageExts[strings.ToLower(path.Ext(name))] && IsText(content) {
		return utf8.RuneCount(content), false
	}
	return 0, true
}
