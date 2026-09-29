// Package release 是上线：每分钟看一次最新发布，比运行中的新就下载本平台二进制替换自身、平滑重启
// （全局暂停时不升；同一版本升失败只发一次 online.failed 给秘书，本进程不再重试）。
// Atrium 自己的仓库合入后的任务等含它的版本：新服务起来后跑只读冒烟（status、task ls、--help），
// 通过记「已上线」（task.status 事件带版本），没过转受阻。
//
// 命令：update [--to 版本]。自升级只在默认数据目录、发版版本上开；隔离实例与开发版不动。
// 开发期不做失败自动装回旧版：旧二进制留在 <exe>.old，要退回手动换。
package release

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/service"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Actor 是上线在经历里的署名。
const Actor = "release"

// DefaultRepo 是 Atrium 自己的仓库；ATRIUM_UPDATE_REPO 可改。
const DefaultRepo = "liu-zhengdong/atrium"

// Config 是本实例的上线设置。
type Config struct {
	Repo    string
	Enabled bool
	Why     string // 没开时的原因
	Data    string
	Port    int
}

// ConfigFor 按数据目录、端口、ATRIUM_UPDATE_REPO 与当前版本定本实例的上线设置。
func ConfigFor(p config.Paths, port int) Config {
	repo := strings.TrimSpace(os.Getenv("ATRIUM_UPDATE_REPO"))
	if repo == "" {
		repo = DefaultRepo
	}
	def, err := config.Resolve(func(string) string { return "" })
	c := Config{Repo: repo, Data: p.Data, Port: port}
	if err != nil {
		c.Why = err.Error()
		return c
	}
	c.Enabled, c.Why = SelfUpgrade(p.Data, def.Data, service.Version)
	return c
}

// Tracks 判这个仓库的合入要不要等发版上线。
func (c Config) Tracks(repo string) bool { return c.Enabled && repo == c.Repo }

// Module 是本包接入点。
func Module() app.Module {
	return app.Module{Name: "release", Commands: Commands,
		Run: func(ctx context.Context, env *app.Env) error {
			cfg := ConfigFor(env.Paths, env.Port)
			if !cfg.Enabled {
				env.Log.Info("自升级没开", "why", cfg.Why)
				return nil
			}
			exe, err := os.Executable()
			if err != nil {
				return err
			}
			r := &Releaser{DB: env.DB, Pause: env.Pause, R: gates.NewExec(), Log: env.Log, Cfg: cfg,
				Exe: exe, Current: service.Version, Token: func() (string, error) { return config.ReadToken(env.Paths) }}
			return r.Loop(ctx)
		}}
}

// Releaser 有新版本就升级重启；推进 stage=merged 的任务：冒烟、记已上线。
type Releaser struct {
	DB      *store.DB
	Pause   *pause.Store
	R       gates.Runner
	Log     *slog.Logger
	Cfg     Config
	Exe     string
	Current string
	Token   func() (string, error)
	smoked  *string // 本进程跑过的冒烟结论：空串通过，否则是失败原因
	failed  string  // 本进程升失败过的版本：不再重试
}

// Loop 每分钟看一遍最新发布与等发版的任务（每轮要问 GitHub，不跟着账本变化跑）。
func (r *Releaser) Loop(ctx context.Context) error {
	for {
		if err := r.Sweep(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Minute):
		}
	}
}

// Sweep 一轮：有比运行中新的版本就升级重启（本进程随即退出）；否则当前版本已含合入的任务跑冒烟、记已上线。
func (r *Releaser) Sweep(ctx context.Context) error {
	latest, err := LatestTag(ctx, r.R, r.Cfg.Repo)
	if err != nil {
		r.Log.Warn("查不到最新版本", "err", err)
		return nil
	}
	paused, err := r.Pause.Paused(ctx, pause.Scope{})
	if err != nil {
		return err
	}
	if Upgrade(r.Current, latest, r.Cfg.Enabled, paused, r.failed) {
		if err := r.upgrade(ctx, latest); err != nil && ctx.Err() == nil {
			return r.upgradeFailed(ctx, latest, err)
		}
		return nil
	}
	tasks, err := gates.InStage(ctx, r.DB, ledger.StageMerged)
	if err != nil {
		return err
	}
	for _, t := range tasks {
		if paused, err := gates.Paused(ctx, r.DB, r.Pause, t, ""); err != nil || paused {
			if err != nil {
				return err
			}
			continue
		}
		if err := r.step(ctx, t); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if berr := gates.BlockOnError(ctx, r.DB, r.Log, t.ID, "上线", err); berr != nil {
				return berr
			}
		}
	}
	return nil
}

// step：当前版本含这件任务的合入提交就冒烟、记已上线；还没有就等（30 分钟没版本由 watch 告诉负责人）。
func (r *Releaser) step(ctx context.Context, t ledger.Task) error {
	body, ok, err := gates.Last(ctx, r.DB, t.ID, gates.KindMergeCommit)
	if err != nil || !ok {
		return firstErr(err, fmt.Errorf("%s 没有合入提交登记", t.ID))
	}
	var m struct {
		Commit string `json:"commit"`
	}
	if err := json.Unmarshal([]byte(body), &m); err != nil || m.Commit == "" {
		return fmt.Errorf("%s 的合入提交登记坏了：%s", t.ID, body)
	}
	in, err := Contains(ctx, r.R, r.Cfg.Repo, r.Current, m.Commit)
	if err != nil || !in {
		return err
	}
	return r.online(ctx, t)
}

func (r *Releaser) upgrade(ctx context.Context, tag string) error {
	if err := Install(ctx, r.R, r.Cfg.Repo, tag, r.Exe); err != nil {
		return err
	}
	token, err := r.Token()
	if err != nil {
		return err
	}
	c := &api.Client{Base: fmt.Sprintf("http://127.0.0.1:%d", r.Cfg.Port), Token: token}
	r.Log.Info("已装新版本，平滑重启", "from", r.Current, "to", tag)
	return c.Do(ctx, "POST", "/api/service/restart", nil, nil)
}

// upgradeFailed 记下升失败的版本（本进程不再重试），发一条 online.failed 给秘书。
func (r *Releaser) upgradeFailed(ctx context.Context, tag string, cause error) error {
	r.failed = tag
	r.Log.Error("自升级失败", "from", r.Current, "to", tag, "err", cause)
	return events.Emit(ctx, r.DB, events.Event{Kind: events.OnlineFailed, Target: events.Secretary, By: Actor,
		Body: map[string]string{"from": r.Current, "to": tag, "error": gates.Clip(cause.Error(), 500)}})
}

// online 跑只读冒烟（本进程只跑一次），通过记已上线（task.status 事件带版本）；没过转受阻。
func (r *Releaser) online(ctx context.Context, t ledger.Task) error {
	if r.smoked == nil {
		why := ""
		if err := Smoke(ctx, r.Exe, r.Cfg.Data, r.Cfg.Port); err != nil {
			why = err.Error()
		}
		r.smoked = &why
	}
	if *r.smoked != "" {
		_, err := gates.Block(ctx, r.DB, t.ID, "上线失败（"+r.Current+" 只读冒烟没过）："+*r.smoked)
		return err
	}
	if _, err := ledger.Apply(ctx, r.DB, t.ID, ledger.Event{Kind: ledger.Land, Land: ledger.StageReleased, Final: true}, Actor, "已上线（"+r.Current+"）"); err != nil {
		return err
	}
	return ledger.Record(ctx, r.DB, t.ID, "online", Actor, r.Current)
}

// Smoke 是上线后的只读冒烟：status、task ls（都要 ok:true）、--help。
func Smoke(ctx context.Context, exe, data string, port int) error {
	env, _ := platform.ServiceEnv(runtime.GOOS, platform.EnvMap(os.Environ()))
	env["ATRIUM_DATA"] = data
	env["ATRIUM_PORT"] = strconv.Itoa(port)
	for _, args := range [][]string{{"status", "--json"}, {"task", "ls", "--json"}, {"--help"}} {
		out, err := runExe(ctx, exe, env, args)
		name := "atrium " + strings.Join(args, " ")
		if err != nil {
			return fmt.Errorf("%s：%v：%s", name, err, gates.Clip(out, 500))
		}
		if args[len(args)-1] == "--json" && !bytes.Contains([]byte(out), []byte(`"ok":true`)) {
			return fmt.Errorf("%s 没回 ok:true：%s", name, gates.Clip(out, 500))
		}
	}
	return nil
}

func runExe(ctx context.Context, exe string, env map[string]string, args []string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	var out bytes.Buffer
	cmd, err := platform.Start(platform.Spec{Path: exe, Args: args, Env: env, Stdout: &out, Stderr: &out})
	if err != nil {
		return "", err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-ctx.Done():
		cmd.Process.Kill()
		<-done
		err = ctx.Err()
	}
	return out.String(), err
}

func firstErr(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

// Commands：update。本地完成（服务没在跑也能升级），替换后服务在跑就平滑重启。
func Commands(t *cli.Table) {
	t.Add(cli.Command{Path: "update", Summary: "从 GitHub Release 下载新版本替换自身，服务在跑就平滑重启", Local: true,
		Flags: []cli.Flag{{Name: "to", Value: "版本", Help: "装指定版本（缺省最新）"}},
		Run:   update})
}

// UpdateResult 是 update 的回执。
type UpdateResult struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Exe       string `json:"exe"`
	Restarted bool   `json:"restarted"`
	PID       int    `json:"pid,omitempty"`
}

func update(c *cli.Ctx) error {
	if err := c.MaxArgs(0); err != nil {
		return err
	}
	repo := strings.TrimSpace(c.Env.Getenv("ATRIUM_UPDATE_REPO"))
	if repo == "" {
		repo = DefaultRepo
	}
	x := gates.NewExec()
	to := c.Str("to")
	if to != "" {
		if _, ok := Parse(to); !ok {
			return api.Usage("--to: 应为 vX.Y.Z，收到 %q", to)
		}
		if !strings.HasPrefix(to, "v") {
			to = "v" + to
		}
	} else {
		latest, err := LatestTag(c.Context, x, repo)
		if err != nil {
			return err
		}
		if latest == "" {
			return api.NotFound("%s 还没有 Go 版的发版", repo)
		}
		to = latest
	}
	res := UpdateResult{From: service.Version, To: to}
	if Compare(to, service.Version) == 0 {
		return c.Done(res, "已是 "+to, "atrium status")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	res.Exe = exe
	if err := Install(c.Context, x, repo, to, exe); err != nil {
		return err
	}
	p, err := c.Paths()
	if err != nil {
		return err
	}
	if info, err := config.ReadService(p); err == nil && platform.Alive(info.PID) {
		var out struct {
			NewPID int `json:"new_pid"`
		}
		if err := c.Call("POST", "/api/service/restart", nil, &out); err != nil {
			return err
		}
		res.Restarted, res.PID = true, out.NewPID
	}
	text := fmt.Sprintf("已装 %s（原 %s）：%s", to, service.Version, exe)
	if res.Restarted {
		text += fmt.Sprintf("\n服务已平滑重启（新 pid %d）", res.PID)
	}
	return c.Done(res, text, "atrium status")
}
