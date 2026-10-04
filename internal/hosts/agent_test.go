package hosts

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 假执行者：测试二进制自己，按 HOSTS_FAKE_WORKER 的模式干活。三平台都能跑。
func TestMain(m *testing.M) {
	switch os.Getenv("HOSTS_FAKE_WORKER") {
	case "":
		os.Exit(m.Run())
	case "echo":
		temp := os.Getenv("TMPDIR")
		if temp == "" || os.Getenv("TMP") != temp || os.Getenv("TEMP") != temp {
			os.Exit(2)
		}
		if err := os.WriteFile(filepath.Join(temp, "readonly"), []byte("只读缓存"), 0o400); err != nil {
			os.Exit(2)
		}
		wd, _ := os.Getwd()
		fmt.Printf("开工 %s\n", filepath.Base(wd))
		if _, err := os.Stat("README"); err == nil {
			fmt.Println("看到了 README")
		}
		fmt.Println("密钥 " + os.Getenv("MY_KEY") + " 标记 " + os.Getenv("ATRIUM_WORKER") + " 令牌 " + os.Getenv("ATRIUM_WORKER_TOKEN") +
			" 服务 " + os.Getenv("ATRIUM_SERVER"))
		if exe, err := os.Executable(); err == nil && strings.HasPrefix(os.Getenv("PATH"), filepath.Dir(exe)) {
			fmt.Println("代理在 PATH 最前")
		}
		fmt.Println(strings.Repeat("x", 300_000)) // 超过一段的日志，要分段续传
		os.Exit(3)
	case "spawn": // 另开会话留下一个子进程再照 sleep 走：代理重启后要按会话临时目录把它收掉
		env := platform.EnvMap(os.Environ())
		env["HOSTS_FAKE_WORKER"] = "linger"
		exe, _ := os.Executable()
		child, err := platform.Start(platform.Spec{Path: exe, Env: env, Detached: true})
		if err != nil {
			os.Exit(2)
		}
		if err := os.WriteFile(filepath.Join(os.Getenv("TMPDIR"), "linger.pid"), []byte(strconv.Itoa(child.Process.Pid)), 0o600); err != nil {
			os.Exit(2)
		}
		fallthrough
	case "sleep":
		fmt.Println("睡")
		time.Sleep(3 * time.Second)
		fmt.Println("醒")
		os.Exit(0)
	case "gate":
		fmt.Println("睡")
		deadline := time.Now().Add(time.Minute)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(os.Getenv("HOSTS_FAKE_RELEASE")); err == nil {
				fmt.Println("醒")
				os.Exit(0)
			}
			time.Sleep(20 * time.Millisecond)
		}
		os.Exit(1)
	case "forever", "linger":
		fmt.Println("不停")
		time.Sleep(time.Minute)
	case "probe": // 自检的假工具：按自己的文件名表现
		switch strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe") {
		case "codex":
			fmt.Println("codex-cli 9.9.9")
		case "opencode":
			fmt.Fprintln(os.Stderr, "\n  No active Node.js version.\nRun nvm use\nline3\nline4")
			os.Exit(1)
		case "claude":
			time.Sleep(time.Minute)
		}
		os.Exit(0)
	}
}

type fakeAdapter struct{ mode string }

func (f fakeAdapter) Name() string { return "fake" }
func (f fakeAdapter) Spec(req workers.Request, env map[string]string) (platform.Spec, error) {
	exe, err := os.Executable()
	if err != nil {
		return platform.Spec{}, err
	}
	env["HOSTS_FAKE_WORKER"] = f.mode
	if f.mode == "gate" {
		env["HOSTS_FAKE_RELEASE"] = req.Prompt
	}
	return platform.Spec{Path: exe, Dir: req.Dir, Env: env}, nil
}

func init() {
	AdapterFor = func(tool string) (workers.Adapter, bool) {
		switch tool {
		case "echo", "sleep", "spawn", "forever", "gate":
			return fakeAdapter{tool}, true
		}
		return nil, false
	}
	pollWait = 300 * time.Millisecond
	probeEnabled = false // 代理与本机循环不跑本机真装的工具；TestProbe 自己换上假工具
}

type rig struct {
	t      *testing.T
	env    *app.Env
	server *httptest.Server
	user   *api.Client
}

func newRig(t *testing.T) *rig {
	theHub = newHub()
	loadavg = func() float64 { return 0 }
	t.Cleanup(func() { loadavg = readLoadavg })
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}, Port: 4999, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Pause: &pause.Store{DB: db}}
	r := api.NewRouter(env.Log)
	r.AddAuth(func(tok string) (api.Actor, bool) { return api.Actor{ID: "u1", Kind: "user"}, tok == "user-token" })
	Routes(r, env)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return &rig{t: t, env: env, server: srv, user: &api.Client{Base: srv.URL, Token: "user-token"}}
}

func (g *rig) task(id string) {
	_, err := g.env.DB.Exec(`INSERT INTO tasks (id, title, status, host, created_at, updated_at) VALUES (?, ?, 'running', '', 0, 0)`, id, id)
	if err != nil {
		g.t.Fatal(err)
	}
}

// agent 登记一台、接入、跑代理；返回代理与停下它的函数。
func (g *rig) agent(dir string) (*Agent, context.CancelFunc, chan error) {
	g.join(dir)
	return g.start(dir)
}

// join 只登记与接入；模拟 hello/回执的测试不需要启动代理轮询。
func (g *rig) join(dir string) AgentConfig {
	var add AddResult
	if err := g.user.Do(context.Background(), "POST", "/api/hosts", AddInput{Name: "远程", Repos: []string{"*"}}, &add); err != nil {
		g.t.Fatal(err)
	}
	code := add.Code
	cfg, err := JoinServer(context.Background(), dir, g.server.URL, code, platform.EnvMap(os.Environ()))
	if err != nil {
		g.t.Fatal(err)
	}
	// 接入码只能用一次。
	if _, err := JoinServer(context.Background(), t2(g.t), g.server.URL, code, nil); err == nil {
		g.t.Fatal("接入码用第二次应被拒")
	}
	return cfg
}

func t2(t *testing.T) string { return t.TempDir() }

func (g *rig) start(dir string) (*Agent, context.CancelFunc, chan error) {
	a, cancel, done := g.run(dir, nil)
	g.waitOnline(a.Cfg.Host)
	return a, cancel, done
}

// run 起代理（prep 在 Run 之前改它），不等上线。
func (g *rig) run(dir string, prep func(*Agent)) (*Agent, context.CancelFunc, chan error) {
	cfg, err := ReadAgentConfig(dir)
	if err != nil {
		g.t.Fatal(err)
	}
	a := NewAgent(dir, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if prep != nil {
		prep(a)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()
	return a, cancel, done
}

func (g *rig) waitOnline(host string) {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if theHub.isPolling(host) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	g.t.Fatalf("%s 没上线", host)
}

// waitCLIs 等到这台报过工具自检。连上只说明在领指令，自检是另一路上报。
func waitCLIs(t *testing.T, env *app.Env, host string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var h Host
	var err error
	for time.Now().Before(deadline) {
		h, err = Get(context.Background(), env.DB, host)
		if err == nil && h.Info != nil && h.Info.CLIs != nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s 自检 5 秒没报上，最后读到 info=%+v err=%v", host, h.Info, err)
}

func waitExit(t *testing.T, env *app.Env, task string, run int) Exit {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	e, err := WaitExit(ctx, env, task, run)
	if err != nil {
		t.Fatalf("等 %s 退出：%v", task, err)
	}
	return e
}

func TestAgentLaunchLogExit(t *testing.T) {
	g := newRig(t)
	// 假远端：本地 bare 仓库，带 main 分支与 README。
	origin := filepath.Join(t.TempDir(), "a", "b.git")
	seed := t.TempDir()
	gitRun(t, "", "init", "--quiet", "--bare", "-b", "main", origin)
	gitRun(t, "", "init", "--quiet", "-b", "main", seed)
	os.WriteFile(filepath.Join(seed, "README"), []byte("hi"), 0o600)
	gitRun(t, seed, "add", "README")
	gitRun(t, seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init")
	gitRun(t, seed, "push", "--quiet", origin, "main")

	dir := t.TempDir()
	a, stop, done := g.agent(dir)
	defer stop()
	host := a.Cfg.Host
	if host != "h2" {
		t.Fatalf("远程应为 h2，得 %s", host)
	}
	// 自检和连上是两件事：没报上之前 CLIs 还是 nil，挑机器会排队而不是拒绝。
	waitCLIs(t, g.env, host)
	// 挑机器：本机 h1 在；远程在线、登记了 *。
	choice, err := Pick(context.Background(), g.env, Need{Tool: "echo"}, host)
	if err != nil || choice.Kind != "refuse" { // 远程没装 echo（假工具）：指定也拒绝
		t.Fatalf("%+v %v", choice, err)
	}
	g.task("t1")
	log := filepath.Join(g.env.Paths.Data, "logs", "t1.log")
	run, pid, wdir, err := Launch(context.Background(), g.env, host, Assignment{Task: "t1", Tool: "echo",
		Request: workers.Request{Prompt: "第一行\n第二行", PromptFile: filepath.Join(t.TempDir(), "service-only.md")}, Repo: origin, Branch: "t1-x", Base: "main", Env: map[string]string{"MY_KEY": "k1"}, Token: "wt_t1_1_x", Log: log})
	if err != nil || run != 1 || pid <= 0 || wdir != filepath.Join(dir, "repos", "a-b-t1") {
		t.Fatalf("Launch：%d %d %s %v", run, pid, wdir, err)
	}
	e := waitExit(t, g.env, "t1", 1)
	if e.Code == nil || *e.Code != 3 || e.Lost {
		t.Fatalf("退出：%+v", e)
	}
	if prompt, err := os.ReadFile(filepath.Join(dir, "tasks", "t1", "prompt-1.md")); err != nil || string(prompt) != "第一行\n第二行" {
		t.Fatalf("远程提示词未落在代理机器上：%q %v", prompt, err)
	}
	got, _ := os.ReadFile(log)
	s := string(got)
	// 令牌打进输出也会被代理侧落盘脱敏换成占位；MY_KEY 的值太短（k1），不换。
	if !strings.Contains(s, "开工 a-b-t1") || !strings.Contains(s, "看到了 README") || !strings.Contains(s, "密钥 k1 标记 1 令牌 "+platform.Redacted+" 服务 "+a.Cfg.Server) ||
		!strings.Contains(s, "代理在 PATH 最前") || len(got) < 300_000 {
		t.Fatalf("日志不全（%d 字节）：%.200s", len(got), s)
	}
	// 代理那边的运行记录退出后清掉。
	waitFor(t, func() bool {
		_, err := os.Stat(filepath.Join(dir, "runs", "t1.json"))
		return errors.Is(err, os.ErrNotExist)
	})
	// 只读查询：在工作树里跑 git、读根下的文件；不合法的由代理拒绝。
	ctx := context.Background()
	if ack, err := Ask(ctx, host, Query{Dir: wdir, Git: []string{"--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"}}); err != nil || strings.TrimSpace(ack.Output) != "t1-x" {
		t.Fatalf("git 查询：%+v %v", ack, err)
	}
	if ack, err := Ask(ctx, host, Query{Dir: wdir, File: "README"}); err != nil || ack.Output != "hi" || ack.Missing {
		t.Fatalf("读文件：%+v %v", ack, err)
	}
	if ack, err := Ask(ctx, host, Query{Dir: wdir, File: "choice.json"}); err != nil || !ack.Missing {
		t.Fatalf("没有的文件：%+v %v", ack, err)
	}
	if _, err := Ask(ctx, host, Query{Dir: wdir, Git: []string{"push", "origin", "t1-x"}}); err == nil || !strings.Contains(err.Error(), "只跑只读的 git 子命令") {
		t.Fatalf("改东西的 git 应拒绝：%v", err)
	}
	if _, err := Ask(ctx, host, Query{Dir: wdir, Git: []string{"rev-parse", "no-such-ref"}}); err == nil || !strings.Contains(err.Error(), "git rev-parse") {
		t.Fatalf("git 失败应带原因：%v", err)
	}
	// 同一任务第二轮：接着用原工作树。
	run, _, _, err = Launch(context.Background(), g.env, host, Assignment{Task: "t1", Tool: "echo", Request: workers.Request{Prompt: "再做"},
		Repo: origin, Branch: "t1-x", Base: "main", Log: log})
	if err != nil || run != 2 {
		t.Fatalf("第二轮：%d %v", run, err)
	}
	waitExit(t, g.env, "t1", 2)
	// 代理拒绝不合法的指令：回执带原因。
	g.task("t2")
	if _, _, _, err := Launch(context.Background(), g.env, host, Assignment{Task: "t2", Tool: "rm", Request: workers.Request{Prompt: "x"}, Log: log}); err == nil ||
		!strings.Contains(err.Error(), "不认识的执行者工具") {
		t.Fatalf("应拒绝：%v", err)
	}
	if e := waitExit(t, g.env, "t2", 1); !e.Lost {
		t.Fatalf("没拉起的一轮应按退出不明收尾：%+v", e)
	}
	// 移除机器：代理令牌失效，以 ErrRevoked 退出。
	if err := g.user.Do(context.Background(), "DELETE", "/api/hosts/"+host, nil, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, ErrRevoked) {
			t.Fatalf("应为令牌失效：%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("移除后代理没退出")
	}
}

func TestAgentStopAndRestart(t *testing.T) {
	g := newRig(t)
	dir := t.TempDir()
	a, stop, _ := g.agent(dir)
	host := a.Cfg.Host
	g.task("t1")
	g.task("t2")
	log1 := filepath.Join(g.env.Paths.Data, "t1.log")
	if _, _, _, err := Launch(context.Background(), g.env, host, Assignment{Task: "t1", Tool: "forever", Request: workers.Request{Prompt: "x"}, Log: log1}); err != nil {
		t.Fatal(err)
	}
	if err := Stop(context.Background(), g.env, "t1"); err != nil {
		t.Fatal(err)
	}
	if e := waitExit(t, g.env, "t1", 1); e.Code == nil || *e.Code == 0 {
		t.Fatalf("结束后应非 0 退出：%+v", e)
	}
	// 代理停下期间执行者照跑；重启代理后按 pid 接着看，补传日志、补报退出（退出码不可得），并收掉它另开会话留下的子进程。
	log2 := filepath.Join(g.env.Paths.Data, "t2.log")
	_, pid, _, err := Launch(context.Background(), g.env, host, Assignment{Task: "t2", Tool: "spawn", Request: workers.Request{Prompt: "x"}, Log: log2})
	if err != nil {
		t.Fatal(err)
	}
	stop()
	time.Sleep(200 * time.Millisecond)
	if !platform.Alive(pid) {
		t.Fatal("代理停下不该带走执行者")
	}
	_, stop2, _ := g.start(dir)
	defer stop2()
	e := waitExit(t, g.env, "t2", 1)
	if e.Code != nil || e.Lost {
		t.Fatalf("接着看的一轮退出码不可得：%+v", e)
	}
	got, _ := os.ReadFile(log2)
	if !strings.Contains(string(got), "睡") || !strings.Contains(string(got), "醒") {
		t.Fatalf("日志：%q", got)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "tasks", "t2", "tmp", "linger.pid"))
	linger, _ := strconv.Atoi(string(raw))
	if linger == 0 {
		t.Fatal("没拿到残留子进程的 pid")
	}
	defer platform.KillTree(linger)
	deadline := time.Now().Add(5 * time.Second)
	for platform.Alive(linger) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if platform.Alive(linger) {
		t.Fatal("代理重启后没收掉执行者另开会话留下的子进程")
	}
}

func TestReconnectReconcile(t *testing.T) {
	g := newRig(t)
	dir := t.TempDir()
	a, stop, _ := g.agent(dir)
	host := a.Cfg.Host
	stop()
	// 账上说 t9 在这台跑，代理却不知道：重连时按退出不明收尾。
	g.task("t9")
	g.env.DB.Exec(`INSERT INTO host_runs (task, host, run, pid, log_file, started_at) VALUES ('t9', ?, 1, 4242, 'x', 0)`, host)
	_, stop2, _ := g.start(dir)
	defer stop2()
	if e := waitExit(t, g.env, "t9", 1); !e.Lost {
		t.Fatalf("%+v", e)
	}
}

// 这台上标了不可用的「工具+模型」：挑机器不再派给它，同一工具的别的模型照派；到期的不算。
// 用本机 h1，并提供假的实测结果，结果不随测试机器装了什么而变。
func TestPickSkipsMarked(t *testing.T) {
	g := newRig(t)
	ctx := context.Background()
	host := "h1"
	if err := setCLIs(ctx, g.env.DB, host, map[string]CLI{"grok": {Installed: true}}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, m := range []workers.Mark{
		{Tool: "grok", Model: "grok-4.6", Host: host, Kind: workers.SignalQuota, Reason: "额度用尽", Until: now.Add(time.Hour).UnixMilli(), Since: now.UnixMilli()},
		{Tool: "grok", Model: "grok-old", Host: host, Kind: workers.SignalQuota, Reason: "额度用尽", Until: now.Add(-time.Minute).UnixMilli(), Since: now.UnixMilli()},
	} {
		if err := workers.SetMark(ctx, g.env.DB, m); err != nil {
			t.Fatal(err)
		}
	}
	c, err := Pick(ctx, g.env, Need{Tool: "grok", Model: "grok-4.6"}, host)
	if err != nil || c.Kind != "refuse" || !strings.HasPrefix(c.Reason, host+" 上的 grok+grok-4.6 不可用：额度用尽，") {
		t.Fatalf("%+v %v", c, err)
	}
	for _, model := range []string{"grok-5", "grok-old"} {
		if c, err := Pick(ctx, g.env, Need{Tool: "grok", Model: model}, host); err != nil || c.Kind == "refuse" {
			t.Errorf("%s 不该被挡：%+v %v", model, c, err)
		}
	}
}

func TestAgentRoutesAuth(t *testing.T) {
	g := newRig(t)
	oldQuotaAccounts := quota.DisabledAccounts
	defer func() { quota.DisabledAccounts = oldQuotaAccounts }()
	workers.Routes(api.NewRouter(g.env.Log), g.env)
	dir := t.TempDir()
	a, stop, _ := g.agent(dir)
	defer stop()
	ctx := context.Background()
	hostClient := &api.Client{Base: g.server.URL, Token: a.Cfg.Token}
	// 机器令牌只在 /api/agent/* 有效。
	if err := hostClient.Do(ctx, "GET", "/api/hosts", nil, nil); err == nil {
		t.Fatal("机器令牌不该能调用户接口")
	}
	// 伪造令牌、别台的指令回执、别台的运行都拒绝。
	bad := &api.Client{Base: g.server.URL, Token: a.Cfg.Host + "." + strings.Repeat("0", 64)}
	if err := bad.Do(ctx, "POST", "/api/agent/poll", map[string]any{}, nil); err == nil {
		t.Fatal("伪造令牌应拒绝")
	}
	if err := hostClient.Do(ctx, "POST", "/api/agent/ack", Ack{ID: "h9-1-1"}, nil); err == nil {
		t.Fatal("别台的回执应拒绝")
	}
	g.task("t5")
	g.env.DB.Exec(`INSERT INTO host_runs (task, host, run, log_file, started_at) VALUES ('t5', 'h9', 1, 'x', 0)`)
	var ae *api.Error
	if err := hostClient.Do(ctx, "POST", "/api/agent/log", map[string]any{"task": "t5", "run": 1, "offset": 0, "data": []byte("x")}, nil); !errors.As(err, &ae) || ae.Code != "forbidden" {
		t.Fatalf("别台的运行应拒绝：%v", err)
	}
	// 额度上报：按机器记进 quota_cache。
	for _, auto := range []string{"false", "true"} {
		src := "---\nauto: " + auto + "\n---\n"
		if _, err := workers.SaveProfile(ctx, g.env.DB, "harness/claude", workers.Edit{Source: &src}, "u1"); err != nil {
			t.Fatal(err)
		}
		var reply struct {
			Disabled map[string]bool `json:"disabled"`
		}
		if err := hostClient.Do(ctx, "POST", "/api/agent/quota", map[string]any{"readings": []quota.Reading{}}, &reply); err != nil || reply.Disabled["claude"] != (auto == "false") {
			t.Fatalf("远程读取应跟随 auto=%s：%+v %v", auto, reply, err)
		}
	}
	if err := hostClient.Do(ctx, "POST", "/api/agent/quota", map[string]any{"readings": []quota.Reading{{Account: "codex", OK: true, Finger: "f1", ReadAt: store.Now()}}}, nil); err != nil {
		t.Fatal(err)
	}
	var body string
	if err := g.env.DB.QueryRow(`SELECT body FROM quota_cache WHERE account = ?`, a.Cfg.Host+":codex").Scan(&body); err != nil || !strings.Contains(body, `"host":"`+a.Cfg.Host+`"`) {
		t.Fatalf("%q %v", body, err)
	}
	// 用户接口：show、暂停后挑机器不选、本机不能移除。
	var v View
	if err := g.user.Do(ctx, "GET", "/api/hosts/"+a.Cfg.Host, nil, &v); err != nil || v.Conn != ConnOnline || v.Info == nil {
		t.Fatalf("%+v %v", v, err)
	}
	g.env.Pause.Set(ctx, a.Cfg.Host, "u1")
	if c, _ := Pick(ctx, g.env, Need{}, a.Cfg.Host); c.Kind != "refuse" || !strings.Contains(c.Reason, "暂停") {
		t.Fatalf("%+v", c)
	}
	if c, _ := Pick(ctx, g.env, Need{}, ""); c.Kind != "run" || c.Host != "h1" {
		t.Fatalf("%+v", c)
	}
	if err := g.user.Do(ctx, "DELETE", "/api/hosts/h1", nil, nil); err == nil {
		t.Fatal("本机不能移除")
	}
	g.env.DB.Exec(`UPDATE tasks SET host = ? WHERE id = 't5'`, a.Cfg.Host)
	if err := g.user.Do(ctx, "DELETE", "/api/hosts/"+a.Cfg.Host, nil, nil); !errors.As(err, &ae) || ae.Code != "conflict" {
		t.Fatalf("有在跑的任务应拒绝移除：%v", err)
	}
}

func TestTunnelSupervisor(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil || runtime.GOOS == "windows" {
		t.Skip("没有 sh")
	}
	g := newRig(t)
	// 假 ssh：记下参数后立即退出，看服务是否按退避重连。
	bin := t.TempDir()
	calls := filepath.Join(bin, "calls")
	os.WriteFile(filepath.Join(bin, "ssh"), []byte("#!/bin/sh\necho \"$@\" >> "+calls+"\nexit 255\n"), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	var add AddResult
	if err := g.user.Do(context.Background(), "POST", "/api/hosts", AddInput{Name: "ggb", SSH: "me@ggb", Tunnel: "4999:14999"}, &add); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(add.Command, "http://127.0.0.1:14999") {
		t.Fatalf("接入命令应走隧道远端端口：%s", add.Command)
	}
	tunnelScan = 50 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Run(ctx, g.env)
	waitFor(t, func() bool { b, _ := os.ReadFile(calls); return strings.Count(string(b), "\n") >= 2 })
	b, _ := os.ReadFile(calls)
	if !strings.Contains(string(b), "-R 127.0.0.1:14999:127.0.0.1:4999 me@ggb") || !strings.HasPrefix(tunnelStatus(add.Host.ID), "断开") &&
		!strings.HasPrefix(tunnelStatus(add.Host.ID), "已连") {
		t.Fatalf("%s / %s", b, tunnelStatus(add.Host.ID))
	}
	// host edit 换私钥：隧道按新登记重连，带 -i。
	key := filepath.Join(bin, "id_test")
	var ed AddResult
	if err := g.user.Do(context.Background(), "PATCH", "/api/hosts/"+add.Host.ID, EditInput{Key: &key, Join: true}, &ed); err != nil {
		t.Fatal(err)
	}
	if ed.Host.Key != key || !strings.HasPrefix(ed.Code, add.Host.ID+"-") || !strings.Contains(ed.Command, "127.0.0.1:14999") {
		t.Fatalf("edit 回执：%+v", ed)
	}
	waitFor(t, func() bool {
		b, _ := os.ReadFile(calls)
		return strings.Contains(string(b), "-i "+key+" -o IdentitiesOnly=yes")
	})
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("等不到")
}

func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	if dir != "" {
		args = append([]string{"-C", dir}, args...)
	}
	if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
		t.Fatalf("git %v：%v %s", args, err, out)
	}
}
