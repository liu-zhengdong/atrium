// Package web（桩，第二波实现）：只读网页：静态文件 embed 进二进制，只读接口；今天（等你、在做、今天上线）、部门、决定、执行者。设计稿 ~/Atrium/design/atrium-ui.html。
//
// 命令（第二波）：map（开网页）。网页只读：只注册 GET 路由。
// 契约见 internal/README.md。
package web

import "github.com/liu-zhengdong/atrium/internal/app"

// Module 是本包接入点。第二波在这里填 Commands、Routes、Run；cmd/atrium 已把它排进模块列表。
func Module() app.Module { return app.Module{Name: "web"} }
