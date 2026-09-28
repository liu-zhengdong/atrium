// Package app 定义「模块」：每个业务包导出一个 Module()，cmd/atrium 把它们排成列表，
// 服务启动时依次注册路由、拉起后台循环，命令行启动时依次注册命令。
// 新包只改自己的目录；接入只需在 cmd/atrium/main.go 的模块列表里有一行（第一波已为第二波的包全部加好）。
package app

import (
	"context"
	"log/slog"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Env 是服务进程里各模块共享的东西。只放真正全局唯一的；包之间的调用走各包导出的函数。
type Env struct {
	DB    *store.DB
	Paths config.Paths
	Port  int
	Log   *slog.Logger
	Pause *pause.Store
}

// Module 是一个包对外的全部接入点；不需要的字段留 nil。
type Module struct {
	Name string
	// Commands 注册命令（命令行进程里调用，此时没有 Env）。
	Commands func(t *cli.Table)
	// Routes 注册 HTTP 路由（服务进程里调用）。
	Routes func(r *api.Router, env *Env)
	// Run 是后台循环（派活、巡检……）：ctx 取消时返回。返回非 nil 错误会让服务停下。
	// 循环里每次动作前先问 env.Pause.Paused(...)，停机状态下不做自主动作。
	Run func(ctx context.Context, env *Env) error
}
