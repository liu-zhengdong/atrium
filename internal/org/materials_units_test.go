package org

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestReadableUnits(t *testing.T) {
	cases := []struct {
		name, body string
		want       int
		binary     bool
	}{
		{"report.html", "<STYLE>" + strings.Repeat(".outline{color:red}", 5000) + "</STYLE><script>" + strings.Repeat("console.log('字')", 5000) + "</script><!--备注--><h1>报告</h1><p>正文 &amp; 结论</p>", utf8.RuneCountInString("报告正文 & 结论"), false},
		{"report.HTM", `<p title="a > b">你好</p><img src="data:image/png;base64,AAAA">`, 2, false},
		{"report.html", `<p>正文</p><script>没有闭合的脚本`, 2, false},
		{"report.html", `<p>正文</p><style>没有闭合的样式`, 2, false},
		{"report.html", `<p>正文</p><!--没有闭合的注释`, 2, false},
		{"report.html", `<script>假结束</scripture>仍是脚本</script>正文`, 2, false},
		{"report.html", `<p>İ正文</p><ScRiPt>隐藏</sCrIpT>`, 3, false},
		{"report.html", `<script-widget>正文</script-widget>`, 2, false},
		{"report.html", `<p>data:image/png;base64,AAAA 正文</p>`, 3, false},
		{"report.md", "正文 ![图](data:image/png;base64," + strings.Repeat("AAAA", 20000) + ") 结尾", utf8.RuneCountInString("正文 ![图]() 结尾"), false},
		{"report.markdown", `[图]: data:image/png;base64,AAAA`, utf8.RuneCountInString("[图]: "), false},
		{"report.md", "# 报告\n你好ab\n", utf8.RuneCountInString("# 报告\n你好ab\n"), false},
		{"report.txt", "# 报告\n你好ab\n", utf8.RuneCountInString("# 报告\n你好ab\n"), false},
		{"report.txt", "data:image/png;base64,AAAA", 26, false},
		{"report.md", "metadata:,AAAA", utf8.RuneCountInString("metadata:,AAAA"), false},
		{"report.svg", "<svg>正文</svg>", 0, true},
		{"report.html", "\x00正文", 0, true},
	}
	for _, c := range cases {
		t.Run(c.name+"/"+c.body[:min(len(c.body), 30)], func(t *testing.T) {
			units, binary := Units(c.name, []byte(c.body))
			if units != c.want || binary != c.binary {
				t.Fatalf("Units = %d, %v; want %d, %v", units, binary, c.want, c.binary)
			}
		})
	}
}
