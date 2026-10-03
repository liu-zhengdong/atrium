package workers

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/org/leaders"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/watch"
)

// WatchSignal 把日志尾巴翻成 watch 的信号（纯函数）。进程还活着时也会被问，所以只认收尾事件：
// 正常收尾是 done；报错收尾只拿那一行收尾事件认额度用尽，不扫它前面的日志——
// 那里有工具读到的文件、命令输出；思考耗尽单独认。其余报错收尾都是 error：重试与换人由 dispatch 在进程退出后按次数判。
// 通用命令行没见到结束行（没有收尾事件可看）只算 error：巡检只在进程退出后采用它。
func WatchSignal(a *Driver, tail string) watch.Signal {
	if _, ok := thinkingExhausted(tail); ok {
		return watch.SigThinking
	}
	e := a.Ended(tail)
	switch {
	case !e.Known:
		return watch.SigNone
	case e.OK:
		return watch.SigDone
	}
	if _, ok := quotaSignal(errorReport(e.Line), timeNow()); ok {
		return watch.SigQuota
	}
	return watch.SigError
}

// hook 接上 watch 读信号、负责人执行者组合的核对与唤醒的拉起（服务进程里，Routes 装配时调）。
func hook(env *app.Env) {
	watch.Use(watch.Hooks{Signal: func(worker string, tail []byte) watch.Signal {
		r, err := Resolve(context.Background(), env.DB, worker)
		if err != nil {
			return watch.SigNone
		}
		return WatchSignal(r.Adapter, string(tail))
	}})
	org.CheckWorker = func(ctx context.Context, q store.Querier, id string) error {
		_, err := Resolve(ctx, q, id)
		return err
	}
	leaders.SetLauncher(func(ctx context.Context, l leaders.Launch) (platform.Spec, error) {
		return LeaderSpec(ctx, env, l)
	})
	leaders.WakeUsage = func(ctx context.Context, q store.Querier, profile, log string) (string, string, error) {
		model, u, err := LeaderUsage(ctx, q, profile, log)
		if err != nil {
			return "", "", err
		}
		raw, err := json.Marshal(u)
		return model, string(raw), err
	}
}

// LeaderUsage 从负责人一次唤醒的日志段取工具报的实际模型与用量，口径同任务拉起（RunUsage）：
// 档案写了 usage 按声明取，否则用内置工具的解析，再按档案结算。
func LeaderUsage(ctx context.Context, q store.Querier, profile, log string) (string, Usage, error) {
	w, err := Resolve(ctx, q, profile)
	if err != nil {
		return "", Usage{}, err
	}
	p := NewParser(profile)
	p.Feed(log)
	t := p.Trace()
	u := t.Usage
	if w.Rules.Usage != nil {
		u = ExtractUsage(log, *w.Rules.Usage)
	}
	return t.Model, Charge(u, w.Rules), nil
}

// LeaderSpec 把一次负责人唤醒翻成进程调用：按登记的执行者组合解析档案，提示词从标准输入或参数给（不即时补充说明）。
func LeaderSpec(ctx context.Context, env *app.Env, l leaders.Launch) (platform.Spec, error) {
	r, err := Resolve(ctx, env.DB, l.Profile)
	if l.Attempt != nil {
		r, err = selectLeader(ctx, env, l)
		if err == nil {
			l.Attempt.Profile = r.ID
			l.Attempt.Finish = func(ctx context.Context, log string, code int, confirmed bool) (bool, string, error) {
				return finishLeader(ctx, env, r, log, code, confirmed)
			}
		}
	}
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
	if err := launch.WriteFiles(); err != nil {
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
