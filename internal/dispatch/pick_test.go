package dispatch

import (
	"slices"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func TestPickRotation(t *testing.T) {
	for _, priority := range []ledger.Priority{ledger.Normal, ledger.Urgent, ledger.Fix} {
		t.Run(string(priority), func(t *testing.T) {
			in := PickInput{
				Risk: "low", Priority: priority,
				Facts: []Fact{
					{ID: "codex", Account: "codex", Trust: "medium", Stat: workers.Stat{Launches: 1}},
					{ID: "unknown-first", Trust: "medium"},
					{ID: "unknown-second", Trust: "medium"},
				},
				Spares: map[string]Spare{"codex": {Percent: f(90)}},
			}
			for n, want := range []string{"unknown-first", "unknown-second", "codex", "unknown-first", "unknown-second", "codex"} {
				v := Pick(in)
				if v.Recommended != want {
					t.Fatalf("第 %d 次派发推荐 %s，应为 %s；候选：%+v", n+1, v.Recommended, want, v.Candidates)
				}
				for i := range in.Facts {
					if in.Facts[i].ID == v.Recommended {
						in.Facts[i].Stat.Launches++
					}
				}
			}
		})
	}
}

func TestPickRotationOrder(t *testing.T) {
	for _, priority := range []ledger.Priority{ledger.Normal, ledger.Urgent, ledger.Fix} {
		t.Run(string(priority), func(t *testing.T) {
			in := PickInput{
				Risk: "low", Priority: priority,
				Facts: []Fact{
					{ID: "unknown-first", Trust: "medium"},
					{ID: "low", Account: "low", Trust: "medium"},
					{ID: "high-first", Account: "high", Trust: "medium"},
					{ID: "unknown-second", Trust: "medium"},
					{ID: "high-second", Account: "high", Trust: "medium"},
					{ID: "used", Account: "used", Trust: "medium", Stat: workers.Stat{Launches: 1}},
					{ID: "preferred", Trust: "medium", Preferred: 1, Stat: workers.Stat{Launches: 10}},
					{ID: "shaky", Trust: "medium", Preferred: 1, Fails: ShakyFails},
				},
				Spares: map[string]Spare{"low": {Percent: f(-5)}, "high": {Percent: f(50)}, "used": {Percent: f(90)}},
			}
			v := Pick(in)
			var got []string
			for i, c := range v.Candidates {
				got = append(got, c.ID)
				if !c.Eligible || c.Rank != i+1 {
					t.Fatalf("候选资格或排名错误：%+v", c)
				}
			}
			want := []string{"preferred", "high-first", "high-second", "low", "unknown-first", "unknown-second", "used", "shaky"}
			if !slices.Equal(got, want) || v.Recommended != want[0] {
				t.Fatalf("排序 %v，推荐 %s；应为 %v", got, v.Recommended, want)
			}
		})
	}
}

func TestPickProfilePrefer(t *testing.T) {
	others := []Fact{
		{ID: "fresh", Account: "a", Trust: "medium"},
		{ID: "free", Trust: "medium", Cost: priceRules(0)},
	}
	glm := Fact{ID: "glm", Trust: "medium", Prefer: true, Cost: priceRules(1), Stat: workers.Stat{Launches: 10}}
	cases := []struct {
		name   string
		facts  []Fact
		want   string
		reason string
	}{
		{"prefer 压过拉起少、富余多、更便宜的", append(slices.Clone(others), glm), "glm", "档案标了优先（prefer）"},
		{"技能偏好仍在 prefer 前", append(slices.Clone(others), glm, Fact{ID: "skill", Trust: "medium", Preferred: 1}), "skill", "技能指定"},
		{"近期不稳的 prefer 排后", append(slices.Clone(others), func() Fact { g := glm; g.Fails = ShakyFails; return g }()), "fresh", ""},
		{"prefer 不可用就落到其余", append(slices.Clone(others), func() Fact { g := glm; g.Unavailable = "额度用尽"; return g }()), "fresh", ""},
		{"当不了审阅者就落到其余", append(slices.Clone(others), func() Fact { g := glm; g.Refusal = "和作者同一工具"; return g }()), "fresh", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := Pick(PickInput{Risk: "low", Facts: c.facts, Spares: map[string]Spare{"a": {Percent: f(90)}}})
			if v.Recommended != c.want || !strings.Contains(v.Reason, c.reason) {
				t.Fatalf("推荐 %s（%s），应为 %s（含 %q）；候选：%+v", v.Recommended, v.Reason, c.want, c.reason, v.Candidates)
			}
		})
	}
}
