package hosts

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/platform"
)

// 带 --ssh 登记的机器：服务拉起 ssh -N -R 反向隧道（远端 127.0.0.1:远端端口 → 这台 127.0.0.1:本机端口），
// 断开后按 1、2、4… 秒（封顶 60 秒）重连。代理在那台连 http://127.0.0.1:远端端口。

var tunnels = struct {
	sync.Mutex
	status map[string]string
}{status: map[string]string{}}

func setTunnel(id, s string) {
	tunnels.Lock()
	tunnels.status[id] = s
	tunnels.Unlock()
}

func tunnelStatus(id string) string {
	tunnels.Lock()
	defer tunnels.Unlock()
	if s, ok := tunnels.status[id]; ok {
		return s
	}
	return "未启动"
}

// tunnelScan 是多久看一次登记变化（测试调短）。
var tunnelScan = 10 * time.Second

// Run 是 hosts 的后台循环：按登记维持 ssh 隧道；机器移除后结束它的隧道。
func Run(ctx context.Context, env *app.Env) error {
	running := map[string]context.CancelFunc{}
	defer func() {
		for _, cancel := range running {
			cancel()
		}
	}()
	for {
		list, err := List(ctx, env.DB)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		want := map[string]Host{}
		for _, h := range list {
			if h.SSH != "" && h.TunnelLocal != 0 && h.TunnelRemote != 0 {
				want[h.ID] = h
			}
		}
		for id, cancel := range running {
			if _, ok := want[id]; !ok {
				cancel()
				delete(running, id)
				setTunnel(id, "已停")
			}
		}
		for id, h := range want {
			if _, ok := running[id]; !ok {
				tctx, cancel := context.WithCancel(ctx)
				running[id] = cancel
				go superviseTunnel(tctx, env, h)
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(tunnelScan):
		}
	}
}

func superviseTunnel(ctx context.Context, env *app.Env, h Host) {
	penv := platform.EnvMap(os.Environ())
	for attempt := 0; ctx.Err() == nil; attempt++ {
		began := time.Now()
		err := runTunnel(ctx, h, penv)
		if ctx.Err() != nil {
			return
		}
		if time.Since(began) > time.Minute {
			attempt = 0
		}
		wait := time.Duration(TunnelDelay(attempt)) * time.Millisecond
		setTunnel(h.ID, fmt.Sprintf("断开（%v），%s 后重连", err, wait))
		env.Log.Warn("ssh 隧道断开", "host", h.ID, "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func runTunnel(ctx context.Context, h Host, env map[string]string) error {
	path, err := platform.LookPath("ssh", env)
	if err != nil {
		return err
	}
	var errOut bytes.Buffer
	cmd, err := platform.Start(platform.Spec{Path: path, Args: TunnelArgs(h.SSH, h.TunnelLocal, h.TunnelRemote), Env: env, Stderr: &errOut})
	if err != nil {
		return err
	}
	setTunnel(h.ID, fmt.Sprintf("已连（%d:%d）", h.TunnelLocal, h.TunnelRemote))
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-ctx.Done():
		cmd.Process.Kill()
		<-done
		return ctx.Err()
	}
	if msg := strings.TrimSpace(tail(errOut.String(), 300)); msg != "" {
		return fmt.Errorf("%v：%s", err, msg)
	}
	if err == nil {
		return fmt.Errorf("ssh 退出")
	}
	return err
}
