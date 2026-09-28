// atrium 是一个二进制：服务、命令行、远程代理同一个文件。命令表是唯一来源，--help 由它生成。
package main

import (
	"context"
	"os"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/dispatch"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/merge"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/org/leaders"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/release"
	"github.com/liu-zhengdong/atrium/internal/secretary"
	"github.com/liu-zhengdong/atrium/internal/service"
	"github.com/liu-zhengdong/atrium/internal/watch"
	"github.com/liu-zhengdong/atrium/internal/web"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// modules 的顺序决定帮助里命令组的先后。新包不改这里：第一波已为全部包排好位置。
func modules() []app.Module {
	return []app.Module{
		ledger.Module(),
		org.Module(),
		leaders.Module(),
		dispatch.Module(),
		workers.Module(),
		gates.Module(),
		merge.Module(),
		release.Module(),
		watch.Module(),
		events.Module(),
		hosts.Module(),
		quota.Module(),
		web.Module(),
		secretary.Module(),
	}
}

// Table 搭出完整命令表（测试也用它）。
func Table() *cli.Table {
	t := cli.NewTable("atrium", "Atrium：AI 组织的运行底座")
	mods := modules()
	service.Commands(t, mods)
	for _, m := range mods {
		if m.Commands != nil {
			m.Commands(t)
		}
	}
	return t
}

func main() {
	env := cli.Env{Stdout: os.Stdout, Stderr: os.Stderr, Getenv: os.Getenv}
	os.Exit(Table().Main(context.Background(), os.Args[1:], env))
}
