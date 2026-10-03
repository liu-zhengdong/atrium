package hosts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/release/selfupdate"
	"github.com/liu-zhengdong/atrium/internal/service"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 远程代理（atrium agent）：主动长轮询领指令（远程不开入站端口），在这台克隆仓库、建工作树、按同一份适配器拉起执行者，
// 按字节偏移续传日志、补报退出；断线期间执行者照跑，重连后对账。令牌只存这台的 agent.json（0600）。
// 版本跟服务走：hello 回执带服务的版本，代理旧于服务就换成同一版本、退出让系统服务重起（见 catchUp）。

// AdapterFor 按工具名取执行者适配器（workers 包提供；第三波在装配处接上）。没接上时代理拒绝拉起。
var AdapterFor func(tool string) (workers.Adapter, bool)

// ErrRevoked：机器令牌失效（这台被移除或重新登记）。代理以 0 退出，系统服务不再重起它。
var ErrRevoked = errors.New("机器令牌已失效：这台已被移除或重新登记；在服务那台重新 atrium host add 后再接入")

// ErrUpgraded：代理已换成服务的版本。以非 0 退出，系统服务（launchd、systemd、Windows 计划任务）按新二进制重起它；
// 前台跑的要自己再运行 atrium agent。
var ErrUpgraded = errors.New("代理已换成服务的版本，退出让系统服务按新版本重起")

const logChunk = 256 * 1024

// AgentConfig 是 agent.json：接入的服务、这台的短号、机器令牌；Env 是装成系统服务时带上的环境（PATH、出网代理……）。
type AgentConfig struct {
	Server string            `json:"server"`
	Host   string            `json:"host"`
	Token  string            `json:"token"`
	Env    map[string]string `json:"env,omitempty"`
}

// AgentDir 与服务、status 共用数据目录解析。
func AgentDir(getenv func(string) string) (string, error) {
	p, err := config.Resolve(getenv)
	return p.Data, err
}

// AgentIsolated 与服务使用同一目录判定；隔离代理不读本机额度。
func AgentIsolated(dir string) bool {
	return (config.Paths{Data: dir}).Isolated()
}

func writeSecret(path string, v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return platform.WritePrivateFile(path, raw)
}

func ReadAgentConfig(dir string) (AgentConfig, error) {
	var c AgentConfig
	raw, err := os.ReadFile(filepath.Join(dir, "agent.json"))
	if errors.Is(err, os.ErrNotExist) {
		return c, (&api.Error{Code: "not_joined", Message: "这台还没接入（" + dir + " 里没有 agent.json）"}).
			WithNext("atrium agent --server <服务地址> --token <接入码>")
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, fmt.Errorf("agent.json 不是合法 JSON：%w", err)
	}
	return c, nil
}

func SaveAgentConfig(dir string, c AgentConfig) error {
	if err := platform.PrivateDir(dir); err != nil {
		return err
	}
	return writeSecret(filepath.Join(dir, "agent.json"), c)
}

func newClient(server, token string) *api.Client {
	return &api.Client{Base: strings.TrimRight(server, "/"), Token: token, HTTP: &http.Client{Timeout: 60 * time.Second}}
}

// JoinServer 用接入码接入服务，换回机器令牌并存进 agent.json。
func JoinServer(ctx context.Context, dir, server, code string, env map[string]string) (AgentConfig, error) {
	var r struct{ Host, Token string }
	if err := newClient(server, code).Do(ctx, "POST", "/api/agent/join", map[string]any{"info": machineInfo(dir, env)}, &r); err != nil {
		return AgentConfig{}, err
	}
	c := AgentConfig{Server: server, Host: r.Host, Token: r.Token}
	return c, SaveAgentConfig(dir, c)
}

// runRecord 是代理手上一次运行的记录（runs/<任务>.json）：代理重启后据此接着看进程、补传日志与退出。
type runRecord struct {
	RunRef
	PID      int    `json:"pid"`
	Log      string `json:"log"`
	Uploaded int64  `json:"uploaded"`
	Exited   bool   `json:"exited"`
	Code     *int   `json:"code"`
}

type runState struct {
	rec  runRecord
	done chan struct{} // 进程退出后关闭
}

// Agent 是一个在跑的代理。
type Agent struct {
	Dir   string
	Cfg   AgentConfig
	Env   map[string]string // 执行者与找程序用的基础环境：本进程环境叠上 agent.json 的 Env
	Log   *slog.Logger
	Quota *quota.Local // 读这台的额度并上报；nil 不报
	// 自升级：Version 是本代理的版本，Exe 是要替换的可执行文件，GH 下载新版本（nil 用这台执行者环境里的 gh）。
	Version     string
	Exe         string
	GH          selfupdate.Runner
	failed      string            // 本进程升失败过的版本：不再重试
	failure     map[string]string // 还没报给服务的升级失败
	client      *api.Client
	ctx         context.Context // Run 的 ctx：停下时续传也停（执行者照跑，下次启动接着看）
	mu          sync.Mutex
	workspaceMu sync.Mutex // 创建与回收串行，不能在拉起过程中删掉工作树
	runs        map[string]*runState
}

func NewAgent(dir string, cfg AgentConfig, log *slog.Logger) *Agent {
	env := platform.EnvMap(os.Environ())
	for k, v := range cfg.Env {
		env[k] = v
	}
	exe, _ := os.Executable()
	return &Agent{Dir: dir, Cfg: cfg, Env: env, Log: log, Version: service.Version, Exe: exe,
		client: newClient(cfg.Server, cfg.Token), runs: map[string]*runState{}}
}

func (a *Agent) call(ctx context.Context, path string, body, out any) error {
	err := a.client.Do(ctx, "POST", path, body, out)
	var ae *api.Error
	if errors.As(err, &ae) && ae.Status == 401 {
		return ErrRevoked
	}
	return err
}

func (a *Agent) runFile(task string) string { return filepath.Join(a.Dir, "runs", task+".json") }

func (a *Agent) save(r runRecord) error { return writeSecret(a.runFile(r.Task), r) }

// tempDir 是这台上任务的临时目录，也是执行者的会话临时目录：代理重启后 recover 照样算得出。
func (a *Agent) tempDir(task string) string { return filepath.Join(a.Dir, "tasks", task, "tmp") }

// Run 跑到 ctx 取消或令牌失效。断线就按退避重连，执行者照跑。
func (a *Agent) Run(ctx context.Context) error {
	a.ctx = ctx
	for _, d := range []string{"runs", "tasks", "repos"} {
		if err := os.MkdirAll(filepath.Join(a.Dir, d), 0o700); err != nil {
			return err
		}
	}
	if err := a.recover(); err != nil {
		return err
	}
	if a.Quota != nil {
		go a.reportQuota(ctx)
	}
	go a.reportProbes(ctx)
	for attempt := 0; ; attempt++ {
		connected, err := a.session(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(err, ErrRevoked) || errors.Is(err, ErrUpgraded) {
			return err
		}
		if connected {
			attempt = 0
		}
		a.Log.Warn("与服务断开，稍后重连", "err", err)
		select {
		case <-time.After(time.Duration(Backoff(attempt)) * time.Millisecond):
		case <-ctx.Done():
			return nil
		}
	}
}

// recover 读运行记录：没退出的按 pid 接着看（退出码不可得），已退出的补传补报。
func (a *Agent) recover() error {
	entries, err := os.ReadDir(filepath.Join(a.Dir, "runs"))
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(a.Dir, "runs", e.Name()))
		if err != nil {
			return err
		}
		var r runRecord
		if err := json.Unmarshal(raw, &r); err != nil {
			return fmt.Errorf("运行记录 %s 坏了：%w", e.Name(), err)
		}
		st := &runState{rec: r, done: make(chan struct{})}
		a.mu.Lock()
		a.runs[r.Task] = st
		a.mu.Unlock()
		if r.Exited {
			close(st.done)
		} else {
			go func() {
				for platform.Alive(r.PID) {
					select {
					case <-a.ctx.Done():
						return
					case <-time.After(time.Second):
					}
				}
				if err := platform.EndSession(r.PID, a.tempDir(r.Task)); err != nil {
					a.Log.Warn("回收执行者会话残留失败", "task", r.Task, "err", err)
				}
				a.markExit(st, nil)
			}()
		}
		go a.follow(st)
	}
	return nil
}

// session 是一次连接：hello 对账、跟上服务的版本，然后长轮询领指令，出错返回。
func (a *Agent) session(ctx context.Context) (bool, error) {
	var hello struct {
		Stop    []RunRef `json:"stop"`
		Version string   `json:"version"`
		Repo    string   `json:"repo"`
		Paused  bool     `json:"paused"`
	}
	if err := a.call(ctx, "/api/agent/hello", map[string]any{"info": machineInfo(a.Dir, a.Env), "runs": a.agentRuns()}, &hello); err != nil {
		return false, err
	}
	for _, r := range hello.Stop {
		a.stop(r)
	}
	if err := a.catchUp(ctx, hello.Version, hello.Repo, hello.Paused); err != nil {
		return true, err
	}
	a.Log.Info("已连上服务", "server", a.Cfg.Server, "host", a.Cfg.Host)
	for {
		var reply struct {
			Commands []Command `json:"commands"`
		}
		if err := a.call(ctx, "/api/agent/poll", map[string]any{"load": a.load()}, &reply); err != nil {
			return true, err
		}
		for _, c := range reply.Commands {
			switch c.Kind {
			case "launch":
				go a.launchAndAck(ctx, c)
			case "query":
				go a.answer(ctx, c)
			case "reclaim":
				go a.reclaimAndAck(ctx, c)
			case "stop":
				if c.Stop != nil {
					a.stop(*c.Stop)
				}
				a.call(ctx, "/api/agent/ack", Ack{ID: c.ID, OK: true}, nil)
			default:
				a.call(ctx, "/api/agent/ack", Ack{ID: c.ID, Error: "不认识的指令：" + c.Kind}, nil)
			}
		}
	}
}

func (a *Agent) agentRuns() []AgentRun {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := []AgentRun{}
	for _, st := range a.runs {
		out = append(out, AgentRun{RunRef: st.rec.RunRef, Running: !st.rec.Exited})
	}
	return out
}

func (a *Agent) load() Load {
	a.mu.Lock()
	n := 0
	for _, st := range a.runs {
		if !st.rec.Exited {
			n++
		}
	}
	a.mu.Unlock()
	l := loadavg()
	return Load{Load: l, Running: n, Busy: BusyReason(l, runtime.NumCPU())}
}

func (a *Agent) stop(r RunRef) {
	a.mu.Lock()
	st := a.runs[r.Task]
	if st == nil || st.rec.Run != r.Run || st.rec.Exited {
		a.mu.Unlock()
		return
	}
	pid := st.rec.PID
	a.mu.Unlock()
	if err := platform.KillTree(pid); err != nil {
		a.Log.Warn("结束执行者失败", "task", r.Task, "pid", pid, "err", err)
	}
}

func (a *Agent) launchAndAck(ctx context.Context, c Command) {
	ack := Ack{ID: c.ID}
	if c.Launch == nil {
		ack.Error = "拉起指令缺内容"
	} else if pid, dir, err := a.launch(ctx, *c.Launch); err != nil {
		ack.Error = err.Error()
	} else {
		ack.OK, ack.PID, ack.Dir = true, pid, dir
	}
	if err := a.call(ctx, "/api/agent/ack", ack, nil); err != nil {
		a.Log.Warn("回执没送到", "id", c.ID, "err", err)
	}
}

func knownTool(t string) bool {
	if AdapterFor == nil {
		return false
	}
	_, ok := AdapterFor(t)
	return ok
}

// launch 在这台准备工作目录并拉起执行者，返回 pid 与工作目录。
func (a *Agent) launch(ctx context.Context, as Assignment) (int, string, error) {
	a.workspaceMu.Lock()
	defer a.workspaceMu.Unlock()
	if AdapterFor == nil {
		return 0, "", errors.New("代理没接上执行者适配器")
	}
	if why := AssignmentRefusal(as, knownTool); why != "" {
		return 0, "", errors.New(why)
	}
	a.mu.Lock()
	if st := a.runs[as.Task]; st != nil && !st.rec.Exited {
		a.mu.Unlock()
		return 0, "", fmt.Errorf("%s 的第 %d 轮还在跑", as.Task, st.rec.Run)
	}
	a.mu.Unlock()
	taskDir := filepath.Join(a.Dir, "tasks", as.Task)
	if err := os.MkdirAll(taskDir, 0o700); err != nil {
		return 0, "", err
	}
	cwd, err := a.workDir(ctx, as)
	if err != nil {
		return 0, "", err
	}
	adapter, _ := AdapterFor(as.Tool)
	tempDir := a.tempDir(as.Task)
	if err := os.MkdirAll(tempDir, 0o700); err != nil {
		return 0, "", err
	}
	env := platform.WorkerEnv(runtime.GOOS, a.Env, tempDir)
	for k, v := range as.Env {
		env[k] = v
	}
	// 执行者的命令行经代理连的同一个服务地址、凭这次的令牌连回去；代理这个二进制排进 PATH，远程机器上也有 atrium。
	env["ATRIUM_SERVER"], env["ATRIUM_WORKER_TOKEN"] = a.Cfg.Server, as.Token
	platform.SelfOnPath(env)
	req := as.Request
	req.Task, req.Dir = as.Task, cwd
	// 服务传来的 PromptFile 是另一台机器上的路径；代理写下本轮说明供 stdin 和文件参数读取。
	req.PromptFile = filepath.Join(taskDir, fmt.Sprintf("prompt-%d.md", as.Run))
	if err := os.WriteFile(req.PromptFile, []byte(req.Prompt), 0o600); err != nil {
		return 0, "", err
	}
	spec, err := adapter.Spec(req, env)
	if err != nil {
		return 0, "", err
	}
	logPath := filepath.Join(taskDir, "run-"+strconv.Itoa(as.Run)+".log")
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, "", err
	}
	defer f.Close()
	spec.ManagedTree = true
	spec.Stdout, spec.Stderr, spec.Detached = f, f, true
	if spec.Dir == "" {
		spec.Dir = cwd
	}
	if spec.Env == nil {
		spec.Env = env
	}
	cmd, err := platform.Start(spec)
	if err != nil {
		return 0, "", err
	}
	st := &runState{rec: runRecord{RunRef: RunRef{as.Task, as.Run}, PID: cmd.Process.Pid, Log: logPath}, done: make(chan struct{})}
	if err := a.save(st.rec); err != nil {
		platform.KillTree(cmd.Process.Pid)
		platform.WaitSession(cmd, tempDir)
		return 0, "", err
	}
	a.mu.Lock()
	a.runs[as.Task] = st
	a.mu.Unlock()
	go func() {
		err := platform.WaitSession(cmd, tempDir)
		if a.ctx.Err() != nil {
			return // 代理已停下：交给下次启动按 pid 接着看、回收残留
		}
		code := 0
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else if err != nil {
			code = -1
		}
		a.markExit(st, &code)
	}()
	go a.follow(st)
	return cmd.Process.Pid, cwd, nil
}

func (a *Agent) markExit(st *runState, code *int) {
	a.mu.Lock()
	st.rec.Exited, st.rec.Code = true, code
	rec := st.rec
	a.mu.Unlock()
	if err := a.save(rec); err != nil {
		a.Log.Error("存运行记录失败", "task", rec.Task, "err", err)
	}
	close(st.done)
}

// queryMax 是查询回执里输出的上限（回执请求体上限 1MB）。
const queryMax = 512 * 1024

// answer 答服务的只读查询：核对（QueryRefusal）后在工作目录里跑 git 或读文件，回执带输出。
func (a *Agent) answer(ctx context.Context, c Command) {
	ack := Ack{ID: c.ID}
	out, missing, err := a.query(ctx, c.Query)
	switch {
	case err != nil:
		ack.Error = err.Error()
	case len(out) > queryMax:
		ack.Error = fmt.Sprintf("输出 %d 字节，超过上限 %d", len(out), queryMax)
	default:
		ack.OK, ack.Output, ack.Missing = true, out, missing
	}
	if err := a.call(ctx, "/api/agent/ack", ack, nil); err != nil {
		a.Log.Warn("回执没送到", "id", c.ID, "err", err)
	}
}

func (a *Agent) query(ctx context.Context, q *Query) (out string, missing bool, err error) {
	if q == nil {
		return "", false, errors.New("查询指令缺内容")
	}
	if why := QueryRefusal(a.Dir, *q); why != "" {
		return "", false, errors.New(why)
	}
	if q.File != "" {
		b, err := os.ReadFile(filepath.Join(q.Dir, q.File))
		if errors.Is(err, os.ErrNotExist) {
			return "", true, nil
		}
		return string(b), false, err
	}
	var stdout, stderr bytes.Buffer
	if err := a.runGit(ctx, q.Dir, q.Git, &stdout, &stderr); err != nil {
		return "", false, fmt.Errorf("git %s 失败：%v：%s", strings.Join(firstArgs(q.Git, 3), " "), err, strings.TrimSpace(tail(stderr.String(), 500)))
	}
	return stdout.String(), false, nil
}

func (a *Agent) git(ctx context.Context, dir string, args ...string) error {
	var out bytes.Buffer
	if err := a.runGit(ctx, dir, args, &out, &out); err != nil {
		return fmt.Errorf("git %s 失败：%v：%s", args[0], err, strings.TrimSpace(tail(out.String(), 500)))
	}
	return nil
}

// runGit 在 dir（空为当前目录）跑一条 git，至多 10 分钟。
func (a *Agent) runGit(ctx context.Context, dir string, args []string, stdout, stderr io.Writer) error {
	if dir != "" {
		args = append([]string{"-C", dir}, args...)
	}
	return a.runTool(ctx, "git", args, stdout, stderr)
}

// runTool 用这台执行者的环境跑一条命令（git、gh），至多 10 分钟。
func (a *Agent) runTool(ctx context.Context, name string, args []string, stdout, stderr io.Writer) error {
	env := platform.WorkerEnv(runtime.GOOS, a.Env)
	env["GIT_TERMINAL_PROMPT"] = "0"
	path, err := platform.LookPath(name, env)
	if err != nil {
		return err
	}
	cmd, err := platform.Start(platform.Spec{Path: path, Args: args, Env: env, Stdout: stdout, Stderr: stderr})
	if err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-time.After(10 * time.Minute):
		cmd.Process.Kill()
		err = <-done
	case <-ctx.Done():
		cmd.Process.Kill()
		err = <-done
	}
	return err
}

func tail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

// follow 续传这一轮的日志，退出后补完并报退出；连不上就隔一会儿再试。
func (a *Agent) follow(st *runState) {
	for {
		exited := false
		select {
		case <-st.done:
			exited = true
		default:
		}
		stale, err := a.upload(st)
		if err == nil && !stale && exited {
			stale, err = a.reportExit(st)
		}
		if stale {
			// 服务已不认这一轮：还在跑就结束它，然后忘掉。
			if !exited {
				platform.KillTree(st.rec.PID)
				<-st.done
			}
			a.forget(st)
			return
		}
		if err != nil && !errors.Is(err, ErrRevoked) {
			a.Log.Debug("续传日志没成", "task", st.rec.Task, "err", err)
		}
		wait := time.Second
		if exited {
			wait = 2 * time.Second
		}
		select {
		case <-a.ctx.Done():
			return
		case <-st.done:
			if !exited {
				continue // 刚退出：马上补传
			}
			time.Sleep(wait)
		case <-time.After(wait):
		}
	}
}

func (a *Agent) forget(st *runState) {
	a.mu.Lock()
	if a.runs[st.rec.Task] == st {
		delete(a.runs, st.rec.Task)
	}
	a.mu.Unlock()
	os.Remove(a.runFile(st.rec.Task))
}

// upload 把日志从已传位置传到文件末尾；返回服务是否已不认这一轮。
func (a *Agent) upload(st *runState) (bool, error) {
	f, err := os.Open(st.rec.Log)
	if err != nil {
		return false, err
	}
	defer f.Close()
	buf := make([]byte, logChunk)
	for {
		a.mu.Lock()
		from := st.rec.Uploaded
		a.mu.Unlock()
		n, err := f.ReadAt(buf, from)
		if n == 0 {
			if err == io.EOF || err == nil {
				return false, nil
			}
			return false, err
		}
		var r struct {
			Offset int64 `json:"offset"`
		}
		err = a.call(a.ctx, "/api/agent/log", map[string]any{"task": st.rec.Task, "run": st.rec.Run, "offset": from, "data": buf[:n]}, &r)
		if isCode(err, "stale") {
			return true, nil
		}
		if err != nil {
			return false, err
		}
		a.mu.Lock()
		st.rec.Uploaded = r.Offset
		rec := st.rec
		a.mu.Unlock()
		if err := a.save(rec); err != nil {
			return false, err
		}
	}
}

// reportExit 报退出；服务还没收全日志时回它收到的位置，下一轮接着传。
func (a *Agent) reportExit(st *runState) (bool, error) {
	fi, err := os.Stat(st.rec.Log)
	if err != nil {
		return false, err
	}
	var r struct {
		Done   bool  `json:"done"`
		Offset int64 `json:"offset"`
	}
	if err := a.call(a.ctx, "/api/agent/exit", map[string]any{"task": st.rec.Task, "run": st.rec.Run, "code": st.rec.Code, "size": fi.Size()}, &r); err != nil {
		return false, err
	}
	if !r.Done {
		a.mu.Lock()
		st.rec.Uploaded = r.Offset
		a.mu.Unlock()
		return false, nil
	}
	return true, nil
}

// reportQuota 每分钟看一次这台的额度读数（读取器自己按 5 分钟缓存），有新读数就报给服务。
func (a *Agent) reportQuota(ctx context.Context) {
	for {
		var policy struct {
			Disabled map[string]bool `json:"disabled"`
		}
		err := a.call(ctx, "/api/agent/quota", map[string]any{"readings": []quota.Reading{}}, &policy)
		if err != nil {
			a.Log.Debug("额度档案没取到", "err", err)
		} else if rs := a.Quota.Due(ctx, policy.Disabled); len(rs) > 0 {
			if err := a.call(ctx, "/api/agent/quota", map[string]any{"readings": rs}, nil); err != nil {
				a.Log.Debug("额度没报上", "err", err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Minute):
		}
	}
}

// reportProbes 上线时自检一轮、之后每 ProbeEvery 一轮（用执行者同一份环境），报给服务；没报上每分钟重试。
func (a *Agent) reportProbes(ctx context.Context) {
	env := platform.WorkerEnv(runtime.GOOS, a.Env)
	var report ProbeReport
	var due time.Time
	var previous []workers.Tool
	sent := false
	for {
		now := time.Now()
		var tools []workers.Tool
		if err := a.client.Do(ctx, "GET", "/api/agent/tools", nil, &tools); err != nil {
			a.Log.Debug("读取工具目录失败", "err", err)
		} else if !now.Before(due) || !slices.Equal(previous, tools) {
			report, due, sent = Probe(ctx, env, tools), now.Add(ProbeEvery), false
			previous = tools
		}
		if ctx.Err() != nil {
			return
		}
		if !sent && !due.IsZero() {
			err := a.call(ctx, "/api/agent/probe", report, nil)
			if sent = err == nil; !sent {
				a.Log.Debug("自检结果没报上", "err", err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Minute):
		}
	}
}
