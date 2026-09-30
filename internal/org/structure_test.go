package org

import (
	"fmt"
	"testing"
)

func TestSubordinateScope(t *testing.T) {
	parents := map[string]string{"o1": "", "o2": "o1", "o5": "o2", "o12": "o2", "o20": "o5", "o30": ""}
	leaders := map[string]string{"o1": "a1", "o5": "a9"}
	for _, c := range []struct {
		who, dept string
		want      bool
	}{
		{"a1", "o5", true}, {"a1", "o20", true},
		{"a1", "o2", false}, {"a1", "o12", false},
		{"a9", "o5", false}, {"a9", "o20", false},
		{Secretary, "o5", true}, {Secretary, "o30", false},
	} {
		if got := SubordinateScope(parents, leaders, c.who)[c.dept]; got != c.want {
			t.Errorf("%s 在 %s 的下属区域 = %t，应为 %t", c.dept, c.who, got, c.want)
		}
	}
}

func TestDirectReports(t *testing.T) {
	parents := map[string]string{"o1": "", "o2": "o1", "o3": "o1", "o4": "o2", "o5": "o2"}
	leaders := map[string]string{"o1": "a1", "o2": "a9", "o3": "a9", "o4": "a10", "o5": "a11"}
	counts := DirectReports(parents, leaders)
	if counts[Secretary] != 1 || counts["a1"] != 1 || counts["a9"] != 2 {
		t.Fatalf("同一位下属管两个部门只算一位：%v", counts)
	}
	for n := 6; n <= 11; n++ {
		d := fmt.Sprintf("o%d", n)
		parents[d] = "o2"
		leaders[d] = fmt.Sprintf("a%d", n+8)
	}
	if err := CheckDirectReports(parents, leaders); err == nil {
		t.Fatal("超过 7 位应拒绝")
	}
}
