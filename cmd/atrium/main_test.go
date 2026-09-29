package main

import (
	"context"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/cli"
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
		t.Errorf("命令 %d 条，超过上限 60", visible)
	}
	// 执行者连着用户的服务时只能跑只读命令：看的与改的分成两条，看的那条标 Read。
	for path, read := range map[string]bool{"quota": true, "quota set": false, "workers": true, "workers edit": false} {
		c, rest := Table().Lookup(strings.Fields(path))
		if c == nil || len(rest) != 0 || c.Read != read {
			t.Errorf("%s 应为 Read=%v", path, read)
		}
	}
	// 不列出的命令在帮助末尾点名，免得找不到。
	var out strings.Builder
	Table().Main(context.Background(), []string{"--help"}, cli.Env{Stdout: &out, Stderr: &out, Getenv: func(string) string { return "" }})
	for _, c := range cmds {
		if c.Hidden && !strings.Contains(out.String(), c.Path) {
			t.Errorf("隐藏命令 %s 没在帮助末尾点名", c.Path)
		}
	}
}
