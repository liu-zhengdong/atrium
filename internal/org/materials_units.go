package org

import (
	"html"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"
)

func Units(name string, content []byte) (units int, binary bool) {
	ext := strings.ToLower(path.Ext(name))
	if imageExts[ext] || !IsText(content) {
		return 0, true
	}
	text := string(content)
	switch ext {
	case ".html", ".htm":
		text = html.UnescapeString(htmlBody(text))
		text = dataURI.ReplaceAllString(text, "")
	case ".md", ".markdown":
		text = dataURI.ReplaceAllString(text, "")
	}
	return utf8.RuneCountInString(text), false
}

var dataURI = regexp.MustCompile(`(?i)\bdata:[^\s<>"'()\[\]]*,[^\s<>"'()\[\]]*`)

// htmlBody 只抽取文本段；原始文本元素必须找到对应结束标签，否则消费到文件末尾。
func htmlBody(text string) string {
	var body strings.Builder
	lower := strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}, text)
	for i := 0; i < len(text); {
		if text[i] != '<' {
			end := strings.IndexByte(text[i:], '<')
			if end < 0 {
				end = len(text) - i
			}
			body.WriteString(strings.TrimSpace(text[i : i+end]))
			i += end
			continue
		}
		if strings.HasPrefix(text[i:], "<!--") {
			end := strings.Index(text[i+4:], "-->")
			if end < 0 {
				break
			}
			i += 4 + end + 3
			continue
		}
		end, tag, closing := htmlTag(text, i)
		if end == i {
			body.WriteByte('<')
			i++
			continue
		}
		i = end
		if !closing && (tag == "script" || tag == "style") {
			for i < len(text) {
				next := strings.Index(lower[i:], "</"+tag)
				if next < 0 {
					i = len(text)
					break
				}
				i += next
				end, closeTag, closing := htmlTag(text, i)
				if closing && closeTag == tag {
					i = end
					break
				}
				i++
			}
		}
	}
	return body.String()
}

// htmlTag 跳过引号内的 >，返回标签后的偏移；不是标签则不消费。
func htmlTag(text string, start int) (end int, tag string, closing bool) {
	i := start + 1
	if i == len(text) {
		return start, "", false
	}
	if text[i] == '/' {
		closing = true
		i++
	}
	name := i
	for i < len(text) && ((text[i] >= 'a' && text[i] <= 'z') || (text[i] >= 'A' && text[i] <= 'Z') || (text[i] >= '0' && text[i] <= '9') || text[i] == '-' || text[i] == ':') {
		i++
	}
	if name == i && (i >= len(text) || (text[i] != '!' && text[i] != '?')) {
		return start, "", false
	}
	tag = strings.ToLower(text[name:i])
	var quote byte
	for ; i < len(text); i++ {
		c := text[i]
		if quote != 0 {
			if c == quote {
				quote = 0
			}
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			continue
		}
		if c == '>' {
			return i + 1, tag, closing
		}
	}
	return len(text), tag, closing
}
