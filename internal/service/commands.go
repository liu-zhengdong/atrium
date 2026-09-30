package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
)

var scopeFlags = []cli.Flag{
	{Name: "org", Value: "oN", Help: "只停这个部门（含下属）"},
	{Name: "host", Value: "hN", Help: "只停这台机器"},
}

// Commands 注册服务命令；mods 是 serve 要装载的全部模块。
func Commands(t *cli.Table, mods []app.Module) {
	t.Default = "start"
	t.Add(cli.Command{Path: "start", Summary: "启动后台服务（不带命令时也是它）", Local: true,
		Run: func(c *cli.Ctx) error { return start(c) }})
	t.Add(cli.Command{Path: "serve", Summary: "服务进程入口（由 start 拉起）", Local: true, Hidden: true,
		Run: func(c *cli.Ctx) error { return Serve(mods, c.Env.Getenv) }})
	t.Add(cli.Command{Path: "status", Summary: "看服务是否在跑、端口、暂停范围", Local: true,
		Run: func(c *cli.Ctx) error { return status(c) }})
	t.Add(cli.Command{Path: "stop", Summary: "停下服务（在途请求排空后退出）", Local: true,
		Flags: []cli.Flag{{Name: "force", Bool: true, Help: "服务不响应时强制结束进程"}},
		Run:   func(c *cli.Ctx) error { return stop(c) }})
	t.Add(cli.Command{Path: "restart", Summary: "平滑重启：新进程接手，在跑的执行者不中断",
		Run: func(c *cli.Ctx) error { return restart(c) }})
	t.Group("auth", "认证")
	t.Add(cli.Command{Path: "auth rotate", Summary: "换用户令牌（旧令牌立即作废）",
		Run: func(c *cli.Ctx) error {
			var r map[string]string
			if err := c.Call("POST", "/api/auth/rotate", nil, &r); err != nil {
				return err
			}
			return c.Done(r, "已换用户令牌，新令牌在 "+r["token_file"], "atrium status")
		}})
	t.Add(cli.Command{Path: "pause", Summary: "一键停机：停下分派任务、唤醒、周期任务、合入、发版", Flags: scopeFlags,
		Run: func(c *cli.Ctx) error { return setPause(c, true) }})
	t.Add(cli.Command{Path: "resume", Summary: "撤销 pause（不带参数只撤全局那一条）", Flags: scopeFlags,
		Run: func(c *cli.Ctx) error { return setPause(c, false) }})
}

// running 判定服务是否真在跑：登记文件在、进程活着、/health 回的 pid 一致。
func running(p config.Paths) (config.ServiceInfo, bool) {
	info, err := config.ReadService(p)
	if err != nil || !platform.Alive(info.PID) {
		return info, false
	}
	return info, probe(info.Port) == info.PID
}

func probe(port int) int {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var h struct {
		PID int `json:"pid"`
	}
	c := &api.Client{Base: fmt.Sprintf("http://127.0.0.1:%d", port), HTTP: &http.Client{}}
	if err := c.Do(ctx, "GET", "/health", nil, &h); err != nil {
		return 0
	}
	return h.PID
}

// waitUp 等 pid 这个服务登记好并响应 /health。
func waitUp(p config.Paths, pid int, limit time.Duration, exited <-chan error) (config.ServiceInfo, error) {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if info, err := config.ReadService(p); err == nil && info.PID == pid && probe(info.Port) == pid {
			return info, nil
		}
		if exited == nil && !platform.Alive(pid) {
			return config.ServiceInfo{}, fmt.Errorf("服务进程 %d 已退出；看日志 %s", pid, p.Log())
		}
		select {
		case err := <-exited:
			return config.ServiceInfo{}, err
		case <-time.After(50 * time.Millisecond):
		}
	}
	return config.ServiceInfo{}, fmt.Errorf("服务 %d 在 %s 内没起来；看日志 %s", pid, limit, p.Log())
}

func start(c *cli.Ctx) error {
	p, err := c.Paths()
	if err != nil {
		return err
	}
	if info, ok := running(p); ok {
		return c.Done(info, fmt.Sprintf("服务已在运行（pid %d，端口 %d）", info.PID, info.Port), "atrium status")
	}
	pid, dropped, exited, err := spawnServe(p, platform.EnvMap(os.Environ()), 0)
	if err != nil {
		return err
	}
	if len(dropped) > 0 && !c.JSON {
		fmt.Fprintf(c.Env.Stderr, "已忽略身份/凭据环境变量：%s；服务与执行者不继承这些变量。\n", strings.Join(dropped, ", "))
	}
	info, err := waitUp(p, pid, 10*time.Second, exited)
	if err != nil {
		return err
	}
	return c.Done(info, fmt.Sprintf("服务已启动（pid %d，端口 %d，数据目录 %s）", info.PID, info.Port, p.Data), "atrium status")
}

func status(c *cli.Ctx) error {
	p, err := c.Paths()
	if err != nil {
		return err
	}
	info, ok := running(p)
	if !ok {
		msg := "服务没在运行（数据目录 " + p.Data + "）"
		if info.PID != 0 {
			msg += fmt.Sprintf("；登记文件里的 pid %d 已不响应", info.PID)
		}
		return c.Done(map[string]any{"running": false, "data": p.Data}, msg, "atrium start")
	}
	var st Status
	if err := c.Call("GET", "/api/status", nil, &st); err != nil {
		return err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "服务在运行：pid %d，端口 %d，版本 %s\n数据目录：%s\n启动于：%s\n", st.PID, st.Port, st.Version, st.Data,
		time.UnixMilli(st.StartedAt).Format("2006-01-02 15:04:05"))
	next := "atrium task ls"
	if len(st.Pauses) == 0 {
		b.WriteString("暂停：无")
	} else {
		scopes := make([]string, len(st.Pauses))
		for i, e := range st.Pauses {
			scopes[i] = e.Scope
		}
		fmt.Fprintf(&b, "暂停：%s", strings.Join(scopes, "、"))
		next = "atrium resume" + scopeFlag(st.Pauses[0].Scope)
	}
	return c.Done(map[string]any{"running": true, "service": st}, b.String(), next)
}

func stop(c *cli.Ctx) error {
	p, err := c.Paths()
	if err != nil {
		return err
	}
	info, err := config.ReadService(p)
	if errors.Is(err, config.ErrNotRegistered) || (err == nil && !platform.Alive(info.PID)) {
		return c.Done(map[string]any{"stopped": false}, "服务本来就没在运行", "atrium start")
	}
	if err != nil {
		return err
	}
	if c.Bool("force") {
		if err := platform.KillTree(info.PID); err != nil {
			return err
		}
		os.Remove(p.Service())
	} else if err := c.Call("POST", "/api/service/stop", nil, nil); err != nil {
		var ae *api.Error
		if errors.As(err, &ae) && ae.Code == "not_running" {
			ae.Message += "；进程还在但不响应"
			ae.Next = "atrium stop --force"
		}
		return err
	}
	deadline := time.Now().Add(20 * time.Second)
	for platform.Alive(info.PID) {
		if time.Now().After(deadline) {
			return (&api.Error{Code: "timeout", Message: fmt.Sprintf("服务 %d 20 秒内没退出", info.PID)}).WithNext("atrium stop --force")
		}
		time.Sleep(50 * time.Millisecond)
	}
	return c.Done(map[string]any{"stopped": true, "pid": info.PID}, fmt.Sprintf("服务已停下（pid %d）", info.PID), "atrium start")
}

func restart(c *cli.Ctx) error {
	p, err := c.Paths()
	if err != nil {
		return err
	}
	var r struct {
		Old int `json:"old_pid"`
		New int `json:"new_pid"`
	}
	if err := c.Call("POST", "/api/service/restart", nil, &r); err != nil {
		return err
	}
	info, err := waitUp(p, r.New, 20*time.Second, nil)
	if err != nil {
		return err
	}
	return c.Done(map[string]any{"old_pid": r.Old, "service": info},
		fmt.Sprintf("服务已重启（pid %d → %d，端口 %d）", r.Old, info.PID, info.Port), "atrium status")
}

func setPause(c *cli.Ctx, on bool) error {
	if err := c.MaxArgs(0); err != nil {
		return err
	}
	scope := pause.All
	switch {
	case c.Has("org") && c.Has("host"):
		return cli.UsageError("--org 与 --host 一次只给一个")
	case c.Has("org"):
		scope = c.Str("org")
	case c.Has("host"):
		scope = c.Str("host")
	}
	path, verb := "/api/resume", "已恢复"
	if on {
		path, verb = "/api/pause", "已暂停"
	}
	var list []pause.Entry
	if err := c.Call("POST", path, map[string]string{"scope": scope}, &list); err != nil {
		return err
	}
	text := verb + " " + scope
	next := "atrium resume" + scopeFlag(scope)
	if !on {
		next = "atrium status"
		if len(list) > 0 {
			scopes := make([]string, len(list))
			for i, e := range list {
				scopes[i] = e.Scope
			}
			text += "；仍在暂停：" + strings.Join(scopes, "、")
			next = "atrium resume" + scopeFlag(list[0].Scope)
		}
	}
	return c.Done(map[string]any{"scope": scope, "pauses": list}, text, next)
}

func scopeFlag(scope string) string {
	switch {
	case scope == pause.All:
		return ""
	case strings.HasPrefix(scope, "h"):
		return " --host " + scope
	}
	return " --org " + scope
}
