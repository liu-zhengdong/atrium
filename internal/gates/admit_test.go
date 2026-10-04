package gates

import (
	"strings"
	"testing"
)

func TestAdmit(t *testing.T) {
	pr := func(draft bool) *PR {
		return &PR{Number: 7, URL: "https://github.com/o/r/pull/7", State: "OPEN", Draft: draft}
	}
	cases := []struct {
		name    string
		pr      *PR
		reply   string
		want    []string // reasons 里必须有的片段；空表示没有要交回的原因
		blocked []string // blocked 里必须有的片段；空表示不停车
	}{
		{"就绪且完成", pr(false), "做完了\n交付结论：完成", nil, nil},
		{"没写结论不拦", pr(false), "做完了，忘了写那一行", nil, nil},
		{"没有 PR 只看结论", nil, "交付结论：完成", nil, nil},
		{"草稿", pr(true), "做完了\n交付结论：完成", []string{"gh pr ready 7 -R o/r", "或修完再交"}, nil},
		{"没做成", pr(false), "还差测试\n交付结论：没做成", []string{"交付结论：没做成（还差测试）", "修完再交", "交付结论：完成"}, nil},
		{"未完成", pr(false), "差一步\n交付结论：未完成", []string{"交付结论：未完成（差一步）"}, nil},
		{"受阻停车不交回", pr(false), "等设计稿\n交付结论：受阻", nil, []string{"交付结论：受阻（等设计稿）", "停下等外部依赖", "不算失败"}},
		{"受阻加草稿也只停车", pr(true), "等 #806 合入\n交付结论：受阻", nil, []string{"交付结论：受阻（等 #806 合入）"}},
		{"受阻原因写在同一行", pr(false), "交付结论：受阻：等 #806 合入", nil, []string{"交付结论：受阻（等 #806 合入）"}},
		{"草稿加没做成两条都给", pr(true), "没写完\n交付结论：没做成", []string{"gh pr ready 7 -R o/r", "交付结论：没做成"}, nil},
		{"已合并不当草稿拦", &PR{Number: 7, State: "MERGED", Draft: true}, "交付结论：完成", nil, nil},
		{"结论不在最后一行不猜", pr(false), "交付结论：完成\n后来又写了别的", nil, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			reasons, blocked := Admit(c.pr, c.reply)
			got := strings.Join(reasons, "；")
			if len(c.want) == 0 && got != "" {
				t.Fatalf("不应有交回原因，得到 %q", got)
			}
			for _, w := range c.want {
				if !strings.Contains(got, w) {
					t.Errorf("原因缺 %q：%s", w, got)
				}
			}
			if len(c.blocked) == 0 && blocked != "" {
				t.Fatalf("不应停车，得到 %q", blocked)
			}
			for _, w := range c.blocked {
				if !strings.Contains(blocked, w) {
					t.Errorf("停车原因缺 %q：%s", w, blocked)
				}
			}
		})
	}
}
