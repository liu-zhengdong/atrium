// Package hosts 是机器：登记（本机固定 h1，远程 hN）、一次性接入码换机器令牌、给 dispatch 挑机器、ssh 反向隧道；
// 以及同一个二进制里的远程代理（atrium agent）：长轮询领指令、在那台拉起执行者、续传日志、补报退出、上报额度。
//
// 给 dispatch：Pick（挑机器）、Launch（派到远程）、Stop、WaitExit。代理用的执行者适配器经 AdapterFor 接入。
// 契约见 internal/README.md。
package hosts

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/quota"
)

func Module() app.Module {
	return app.Module{Name: "hosts", Commands: Commands, Routes: Routes, Run: Run}
}

func Commands(t *cli.Table) {
	t.Group("host", "机器")
	t.Add(cli.Command{Path: "host add", Args: "<名称>", Summary: "登记一台远程机器，给一次性接入码（30 分钟有效）",
		Flags: []cli.Flag{
			{Name: "repo", Value: "owner/name|*", Multi: true, Help: "自动派活能接的仓库（* 为全部）；不登记只接 --host 指定的活"},
			{Name: "max", Value: "N", Help: "同时最多跑几个执行者（缺省按那台核数）"},
			{Name: "ssh", Value: "user@地址", Help: "由服务拉起 ssh 反向隧道连那台（断开自动重连）"},
			{Name: "tunnel", Value: "本机端口:远端端口", Help: "隧道两端端口（缺省都用服务端口）"},
		},
		Run: func(c *cli.Ctx) error {
			name, err := c.Arg(0, "<名称>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			max, err := c.Int("max", 0)
			if err != nil {
				return err
			}
			var r AddResult
			if err := c.Call("POST", "/api/hosts", AddInput{Name: name, Repos: c.List("repo"), Max: max, SSH: c.Str("ssh"), Tunnel: c.Str("tunnel")}, &r); err != nil {
				return err
			}
			text := fmt.Sprintf("已登记 %s（%s）。接入码 30 分钟内有效、只能用一次。\n在那台机器上运行：\n  %s", r.Host.ID, r.Host.Name, r.Command)
			if r.Host.SSH == "" {
				text += "\n那台连不到本机 127.0.0.1 时，改用 --ssh 让服务建反向隧道，或把 --server 换成能连到的地址。"
			}
			return c.Done(r, text, "atrium host show "+r.Host.ID)
		}})
	t.Add(cli.Command{Path: "host ls", Summary: "列出机器：连接、暂停、在跑、上限",
		Run: func(c *cli.Ctx) error {
			var vs []View
			if err := c.Call("GET", "/api/hosts", nil, &vs); err != nil {
				return err
			}
			var b strings.Builder
			for _, v := range vs {
				max := "不限"
				if v.Max > 0 {
					max = strconv.Itoa(v.Max)
				}
				fmt.Fprintf(&b, "%-4s %s  %s  在跑 %d / %s\n", v.ID, v.Name, v.Status, v.Running, max)
			}
			return c.Done(vs, b.String(), "atrium host show <hN>")
		}})
	t.Add(cli.Command{Path: "host show", Args: "<hN>", Summary: "看一台机器：系统、编码 CLI、仓库、隧道",
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<hN>")
			if err != nil {
				return err
			}
			var v View
			if err := c.Call("GET", "/api/hosts/"+id, nil, &v); err != nil {
				return err
			}
			return c.Done(v, formatView(v), "atrium host ls")
		}})
	t.Add(cli.Command{Path: "host rm", Args: "<hN>", Summary: "移除远程机器（令牌作废，短号不复用）",
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<hN>")
			if err != nil {
				return err
			}
			if err := c.Call("DELETE", "/api/hosts/"+id, nil, nil); err != nil {
				return err
			}
			return c.Done(map[string]string{"id": id}, "已移除 "+id+"；那台的代理下次连上会收到令牌失效并退出", "atrium host ls")
		}})
	t.Group("agent", "远程代理")
	dataFlag := cli.Flag{Name: "data", Value: "目录", Help: "代理数据目录（缺省 ATRIUM_AGENT_DATA 或 ~/.atrium-agent）"}
	// 代理入口与 serve 一样不列在帮助里：host add 的回执给出完整命令，装成服务后由 agent install 拉起。
	t.Add(cli.Command{Path: "agent", Summary: "在远程机器上跑代理（前台）：第一次用 --server 与 --token 接入", Local: true, Hidden: true,
		Flags: []cli.Flag{
			{Name: "server", Value: "URL", Help: "服务地址，如 http://127.0.0.1:4320"},
			{Name: "token", Value: "接入码", Help: "host add 给的一次性接入码"},
			dataFlag,
		},
		Run: runAgent})
	t.Add(cli.Command{Path: "agent install", Summary: "把代理装成系统服务（登录自启、异常 10 秒后重起）", Local: true,
		Flags: []cli.Flag{
			{Name: "status", Bool: true, Help: "只看服务状态"},
			{Name: "uninstall", Bool: true, Help: "卸载服务（agent.json 保留）"},
			dataFlag,
		},
		Run: installAgent})
}

func formatView(v View) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s（%s）\n状态：%s\n在跑：%d", v.ID, v.Name, v.Kind, v.Status, v.Running)
	if v.Max > 0 {
		fmt.Fprintf(&b, " / 上限 %d", v.Max)
	}
	b.WriteString("\n")
	if v.Kind == "remote" {
		repos := "只接 --host 指定的活"
		if len(v.Repos) > 0 {
			repos = strings.Join(v.Repos, "、")
		}
		fmt.Fprintf(&b, "仓库：%s\n", repos)
	}
	if v.Info != nil {
		fmt.Fprintf(&b, "系统：%s/%s，%d 核，%s\n", v.Info.OS, v.Info.Arch, v.Info.CPUs, v.Info.Hostname)
		var clis []string
		for _, t := range Tools {
			c, ok := v.Info.CLIs[t.Name]
			if !ok {
				continue
			}
			s := t.Name
			switch {
			case c.LoggedIn == nil:
				s += "（登录看不出）"
			case !*c.LoggedIn:
				s += "（没登录）"
			}
			clis = append(clis, s)
		}
		if len(clis) == 0 {
			clis = []string{"没装"}
		}
		fmt.Fprintf(&b, "编码 CLI：%s\n", strings.Join(clis, "、"))
	}
	if v.Load != nil && v.Kind == "remote" {
		fmt.Fprintf(&b, "负载：%.1f", v.Load.Load)
		if v.Load.Busy != "" {
			fmt.Fprintf(&b, "（%s）", v.Load.Busy)
		}
		b.WriteString("\n")
	}
	if v.SSH != "" {
		fmt.Fprintf(&b, "隧道：%s %d:%d，%s\n", v.SSH, v.TunnelLocal, v.TunnelRemote, v.Tunnel)
	}
	return b.String()
}

func agentDir(c *cli.Ctx) (string, error) {
	if d := c.Str("data"); d != "" {
		return filepath.Abs(d)
	}
	return AgentDir(c.Env.Getenv)
}

func runAgent(c *cli.Ctx) error {
	if err := c.MaxArgs(0); err != nil {
		return err
	}
	dir, err := agentDir(c)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(c.Context, os.Interrupt, syscall.SIGTERM)
	defer stop()
	env := platform.EnvMap(os.Environ())
	if code := c.Str("token"); code != "" {
		if c.Str("server") == "" {
			return api.Usage("--server: 接入时要给服务地址")
		}
		if _, err := JoinServer(ctx, dir, c.Str("server"), code, env); err != nil {
			return err
		}
	} else if c.Has("server") {
		return api.Usage("--token: 接入时要给接入码；已接入过的直接运行 atrium agent")
	}
	cfg, err := ReadAgentConfig(dir)
	if err != nil {
		return err
	}
	unlock, err := lockAgent(dir)
	if err != nil {
		return err
	}
	defer unlock()
	a := NewAgent(dir, cfg, slog.New(slog.NewTextHandler(c.Env.Stderr, nil)))
	if quota.Enabled(a.Env) {
		home, _ := os.UserHomeDir()
		a.Quota = quota.NewLocal(quota.LocalDeps(runtime.GOOS, home, a.Env))
	}
	if !c.JSON {
		fmt.Fprintf(c.Env.Stdout, "代理已接入 %s（服务 %s，数据目录 %s），开始领活；Ctrl-C 停下，执行者照跑。\n", cfg.Host, cfg.Server, dir)
	}
	err = a.Run(ctx)
	if errors.Is(err, ErrRevoked) {
		return c.Done(map[string]string{"host": cfg.Host, "stopped": "revoked"}, err.Error(), "atrium agent --server <服务地址> --token <新接入码>")
	}
	if err != nil {
		return err
	}
	return c.Done(map[string]string{"host": cfg.Host, "stopped": "signal"}, "代理已停下；在跑的执行者照跑，下次启动接着看", "atrium agent")
}

// lockAgent：同一个数据目录只跑一个代理（agent.pid 里的进程还活着就拒绝）。
func lockAgent(dir string) (func(), error) {
	p := filepath.Join(dir, "agent.pid")
	if raw, err := os.ReadFile(p); err == nil {
		if pid, _ := strconv.Atoi(strings.TrimSpace(string(raw))); pid != os.Getpid() && platform.Alive(pid) {
			return nil, api.Conflict("这个数据目录已有代理在跑（pid %d）", pid).WithNext("atrium agent install --status")
		}
	}
	if err := os.WriteFile(p, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		return nil, err
	}
	return func() { os.Remove(p) }, nil
}

func installAgent(c *cli.Ctx) error {
	if err := c.MaxArgs(0); err != nil {
		return err
	}
	dir, err := agentDir(c)
	if err != nil {
		return err
	}
	action := "install"
	switch {
	case c.Bool("status") && c.Bool("uninstall"):
		return api.Usage("--status 与 --uninstall 只能给一个")
	case c.Bool("status"):
		action = "status"
	case c.Bool("uninstall"):
		action = "uninstall"
	}
	env := map[string]string{}
	for k, v := range platform.EnvMap(os.Environ()) {
		env[platform.EnvKey(runtime.GOOS, k)] = v
	}
	if action == "install" {
		cfg, err := ReadAgentConfig(dir)
		if err != nil {
			return err
		}
		cfg.Env = CarriedEnv(runtime.GOOS, env)
		if err := SaveAgentConfig(dir, cfg); err != nil {
			return err
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	home, _ := os.UserHomeDir()
	rep, err := ManageService(ServiceInput{GOOS: runtime.GOOS, Exe: exe, Data: dir, Home: home, Env: env, UID: os.Getuid()}, action)
	if err != nil {
		return err
	}
	state := "没装"
	switch {
	case rep.State.Running:
		state = "在跑"
	case rep.State.Installed:
		state = "已装（没在跑）"
	}
	text := map[string]string{"install": "已装成系统服务 ", "uninstall": "已卸载 ", "status": ""}[action] +
		fmt.Sprintf("%s：%s\n文件：%s\n日志：%s", rep.Name, state, strings.Join(rep.Files, "、"), rep.Log)
	return c.Done(rep, text, "atrium agent install --status")
}
