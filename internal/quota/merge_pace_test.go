package quota

import (
	"math"
	"reflect"
	"testing"
)

func TestOpenQuotaSpare(t *testing.T) {
	for _, tc := range []struct {
		name string
		pace Pace
		want *float64
	}{
		{"可算", Pace{UsedPercent: ptr(30), ElapsedPct: ptr(50)}, ptr(20)},
		{"负富余", Pace{UsedPercent: ptr(60), ElapsedPct: ptr(50)}, ptr(-10)},
		{"未用", Pace{UsedPercent: ptr(0), ElapsedPct: ptr(50)}, ptr(50)},
		{"来源已有", Pace{UsedPercent: ptr(30), ElapsedPct: ptr(50), SparePercent: ptr(19.9)}, ptr(19.9)},
		{"缺周期进度", Pace{UsedPercent: ptr(30), HoursToReset: ptr(2)}, nil},
		{"缺已用", Pace{ElapsedPct: ptr(50)}, nil},
		{"坏进度", Pace{UsedPercent: ptr(30), ElapsedPct: ptr(101)}, nil},
		{"坏已用", Pace{UsedPercent: ptr(-1), ElapsedPct: ptr(50)}, nil},
		{"非有限进度", Pace{UsedPercent: ptr(30), ElapsedPct: ptr(math.NaN())}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.pace.Account = "antigravity"
			for _, line := range Lines(nil, []Pace{tc.pace}) {
				if line.Account != "antigravity" {
					continue
				}
				if !reflect.DeepEqual(line.SparePercent, tc.want) || !reflect.DeepEqual(SpareOf(line, 20).Percent, tc.want) {
					t.Fatalf("额度与分派富余：%+v，期望 %v", line, tc.want)
				}
				return
			}
			t.Fatal("缺 antigravity 账号")
		})
	}
}
