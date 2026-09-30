package workers

import "testing"

func TestAutoRule(t *testing.T) {
	for _, value := range []string{"", "false", "true"} {
		t.Run("auto="+value, func(t *testing.T) {
			edit := Edit{Set: map[string]string{}}
			if value != "" {
				edit.Set["auto"] = value
			}
			src, err := ApplyEdit("harness/codex", "", edit)
			if err != nil {
				t.Fatal(err)
			}
			keys, _, err := SplitSource(src)
			if err != nil {
				t.Fatal(err)
			}
			r, err := decodeRules(keys)
			if err != nil {
				t.Fatal(err)
			}
			want := ""
			if value == "false" {
				want = "档案 auto=false：只接点名分派任务"
			}
			if got := r.Refusal("low", true); got != want {
				t.Fatalf("自动：%q，期望 %q", got, want)
			}
			if got := r.Refusal("low", false); got != "" {
				t.Fatalf("点名：%s", got)
			}
			if r.Refusal("high", false) == "" {
				t.Fatal("点名仍应检查风险")
			}
			if value != "" {
				src, err = ApplyEdit("harness/codex", src, Edit{Unset: []string{"auto"}})
				if err != nil {
					t.Fatal(err)
				}
				keys, _, _ = SplitSource(src)
				r, err = decodeRules(keys)
				if err != nil || !r.EffectiveAuto() {
					t.Fatalf("删除后恢复缺省：%+v %v", r, err)
				}
			}
		})
	}
	if _, err := ApplyEdit("harness/codex", "", Edit{Set: map[string]string{"auto": "maybe"}}); err == nil {
		t.Fatal("auto=maybe 应报错")
	}
}

func TestAutoLayerOverride(t *testing.T) {
	keys, _ := MergeLayers([]Profile{
		{Keys: map[string]any{"auto": false}},
		{Keys: map[string]any{"auto": true}},
	})
	r, err := decodeRules(keys)
	if err != nil || !r.EffectiveAuto() {
		t.Fatalf("具体层 auto=true 应覆盖 false：%+v %v", r, err)
	}
	keys, _ = MergeLayers([]Profile{
		{Keys: map[string]any{"auto": false}},
		{Keys: map[string]any{"trust": "medium"}},
	})
	r, err = decodeRules(keys)
	if err != nil || r.EffectiveAuto() {
		t.Fatalf("具体层没写 auto 应继承 false：%+v %v", r, err)
	}
}
