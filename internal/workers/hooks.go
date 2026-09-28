package workers

import (
	"bytes"
	"context"
	"os"
	"path/filepath"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/org/leaders"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/watch"
)

// WatchSignal 把日志尾巴翻成 watch 的信号（纯函数）。进程还活着时也会被问，所以只认收尾事件：
// 正常收尾是 done；报错收尾再按额度用尽、临时错误分；思考耗尽单独认。收尾之前的中途报错（工具自己会重试）不算。
func WatchSignal(a *Driver, tail string) watch.Signal {
	if s := Classify(0, tail, timeNow()); s.Kind == SignalThinking {
		return watch.SigThinking
	}
	e := a.Ended(tail)
	switch {
	case !e.Known:
		return watch.SigNone
	case e.OK:
		return watch.SigDone
	}
	switch Classify(1, tail, timeNow()).Kind {
	case SignalQuota:
		return watch.SigQuota
	case SignalTransient:
		return watch.SigTransient
	}
	return watch.SigError
}

// hook 接上 watch 读信号与负责人唤醒的拉起（服务进程里，Routes 装配时调）。
func hook(env *app.Env) {
	watch.Use(watch.Hooks{Signal: func(worker string, tail []byte) watch.Signal {
		r, err := Resolve(context.Background(), env.DB, worker)
		if err != nil {
			return watch.SigNone
		}
		return WatchSignal(r.Adapter, string(tail))
	}})
	leaders.SetLauncher(func(ctx context.Context, l leaders.Launch) (platform.Spec, error) {
		return LeaderSpec(ctx, env, l)
	})
}

// LeaderSpec 把一次负责人唤醒翻成进程调用：按登记的执行者组合解析档案，提示词从标准输入或参数给（不即时捎话）。
func LeaderSpec(ctx context.Context, env *app.Env, l leaders.Launch) (platform.Spec, error) {
	r, err := Resolve(ctx, env.DB, l.Profile)
	if err != nil {
		return platform.Spec{}, err
	}
	file := filepath.Join(l.Dir, "prompt.md")
	if err := os.WriteFile(file, []byte(l.Prompt), 0o600); err != nil {
		return platform.Spec{}, err
	}
	req := r.Request(l.Prompt, file, l.Dir)
	req.Task = l.Leader
	launch, err := Build(r.Spec.Tool, req)
	if err != nil {
		return platform.Spec{}, err
	}
	envs := map[string]string{}
	for k, v := range l.Env {
		envs[k] = v
	}
	for k, v := range launch.Env {
		envs[k] = v
	}
	exe, err := platform.LookPath(launch.Exe, envs)
	if err != nil {
		return platform.Spec{}, err
	}
	spec := platform.Spec{Path: exe, Args: launch.Args, Dir: launch.Dir, Env: envs}
	if launch.StdinFile != "" {
		spec.Stdin = bytes.NewReader([]byte(l.Prompt))
	}
	return spec, nil
}
