package main

import (
	"strings"
	"testing"
)

// 命令表能搭起来（没有重复注册、组都声明了），每条命令都有说明与 Run，数量守住规格的上限。
func TestTable(t *testing.T) {
	cmds := Table().Commands()
	visible := 0
	for _, c := range cmds {
		if c.Summary == "" || c.Run == nil {
			t.Errorf("%s 缺说明或 Run", c.Path)
		}
		if strings.TrimSpace(c.Path) != c.Path || strings.Contains(c.Path, "  ") {
			t.Errorf("命令路径不规整：%q", c.Path)
		}
		if !c.Hidden {
			visible++
		}
	}
	if visible > 60 {
		t.Errorf("命令 %d 条，超过规格上限 60", visible)
	}
}
