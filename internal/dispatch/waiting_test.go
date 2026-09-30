package dispatch

import "testing"

func TestPickWaitingHost(t *testing.T) {
	waiting := Fact{ID: "waiting", Tool: "fake", Trust: "medium", Waiting: "尚未完成工具自检"}
	for _, tc := range []struct {
		name        string
		facts       []Fact
		waiting     bool
		recommended string
	}{
		{"等待自检", []Fact{waiting}, true, ""},
		{"先派已就绪的", []Fact{waiting, {ID: "ready", Tool: "fake", Trust: "medium"}}, false, "ready"},
		{"档案拒绝不能等待", []Fact{{ID: "refused", Waiting: waiting.Waiting, Refusal: "auto=false"}}, false, ""},
		{"不可用不能等待", []Fact{{ID: "missing", Unavailable: "没装 fake"}}, false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := Pick(PickInput{Risk: "low", Facts: tc.facts})
			if v.Waiting != tc.waiting || v.Recommended != tc.recommended {
				t.Fatalf("%+v", v)
			}
		})
	}
}
