package dispatch

import (
	"slices"
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
