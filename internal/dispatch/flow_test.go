package dispatch

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 假执行者：claude 读第一条消息、打会话与收尾、等标准输入关掉才退；codex 报额度用尽；kimi 一直睡。
var fakes = map[string]string{
	"claude": `#!/bin/sh
read first
echo '{"type":"system","subtype":"init","session_id":"0123abcd-0123-0123-0123-0123456789ab"}'
echo "worker=$ATRIUM_WORKER task=$ATRIUM_TASK secret=${DEMO_TOKEN:-none} home=${ANTHROPIC_API_KEY:-clean}"
case "$first" in *'"type":"user"'*) echo got-prompt ;; esac
echo '{"type":"result","is_error":false,"stop_reason":"end_turn","result":"ok"}'
cat >/dev/null
`,
	"codex": `#!/bin/sh
cat >/dev/null
echo "ERROR: You've hit your usage limit. Try again in ~5 min."
exit 1
`,
	"kimi": `#!/bin/sh
echo started
sleep 30
`,
}

func setup(t *testing.T) (*app.Env, *dispatcher) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("假执行者是 sh 脚本")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	os.MkdirAll(bin, 0o755)
	for name, body := range fakes {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+":/usr/bin:/bin")
	t.Setenv("ANTHROPIC_API_KEY", "leak")
	db, err := store.Open(filepath.Join(dir, "data", "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	env := &app.Env{DB: db, Paths: config.Paths{Data: filepath.Join(dir, "data")}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Pause: &pause.Store{DB: db}}
	// 不读开发者本机的额度与机器：只用本机、没有额度数据。
	oldPick, oldSpares := pickHost, spares
	pickHost = func(context.Context, *app.Env, HostNeed, string) (HostChoice, error) {
		return HostChoice{Kind: "run", Host: LocalHost}, nil
	}
	spares = func(context.Context, *app.Env) (map[string]Spare, error) { return map[string]Spare{}, nil }
	t.Cleanup(func() { pickHost, spares = oldPick, oldSpares })
	d := get(env)
	t.Cleanup(func() {
		d.mu.Lock()
		for _, p := range d.procs {
			d.kill(context.Background(), p)
		}
		d.mu.Unlock()
		d.wg.Wait()
	})
	return env, d
}

// gitRepo 建一个本地 bare 远端和它的克隆，返回克隆的绝对路径。
func gitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	git := func(cwd string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = cwd
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v：%v %s", args, err, out)
		}
	}
	git(dir, "init", "--quiet", "--bare", "-b", "main", "remote.git")
	git(dir, "clone", "--quiet", filepath.Join(dir, "remote.git"), "main")
	clone := filepath.Join(dir, "main")
	os.WriteFile(filepath.Join(clone, "README"), []byte("hi"), 0o644)
	git(clone, "add", ".")
	git(clone, "commit", "--quiet", "-m", "init")
	git(clone, "push", "--quiet", "origin", "main")
	git(clone, "remote", "set-head", "origin", "main")
	return clone
}

func waitFor(t *testing.T, env *app.Env, id string, ok func(ledger.Task) bool) ledger.Task {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		tk, err := ledger.Get(context.Background(), env.DB, id)
		if err != nil {
			t.Fatal(err)
		}
		if ok(tk) {
			return tk
		}
		if time.Now().After(deadline) {
			h, _ := ledger.History(context.Background(), env.DB, id, 30)
			t.Fatalf("%s 等不到：%s/%s 经历 %+v", id, tk.Status, tk.Stage, h)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestFlowClaudeToGate(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	repo := gitRepo(t)
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "改 README", Repo: repo}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "claude"}, "u1"); err != nil {
		t.Fatal(err)
	}
	// 停机时不派。
	env.Pause.Set(ctx, pause.All, "u1")
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := ledger.Get(ctx, env.DB, tk.ID); got.Status != ledger.Queued {
		t.Fatalf("停机中不该拉起：%s", got.Status)
	}
	env.Pause.Clear(ctx, pause.All)
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	got := waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
	if got.Worker != "claude+opus" || got.Host != LocalHost {
		t.Fatalf("事实：%+v", got)
	}
	run, _ := workers.LastRun(ctx, env.DB, tk.ID)
	if run == nil || run.Branch != "task-"+tk.ID || run.Dir != filepath.Join(TaskDir(env.Paths.Data, tk.ID), "repo") {
		t.Fatalf("拉起记录：%+v", run)
	}
	if out, err := exec.Command("git", "-C", run.Dir, "rev-parse", "--abbrev-ref", "HEAD").Output(); err != nil || strings.TrimSpace(string(out)) != run.Branch {
		t.Fatalf("worktree 分支：%s %v", out, err)
	}
	log, _ := os.ReadFile(run.Log)
	for _, want := range []string{"worker=1 task=" + tk.ID, "home=clean", "got-prompt"} {
		if !strings.Contains(string(log), want) {
			t.Errorf("日志缺 %q：%s", want, log)
		}
	}
	prompt, _ := os.ReadFile(filepath.Join(TaskDir(env.Paths.Data, tk.ID), "prompt-1.md"))
	if !strings.Contains(string(prompt), "改 README") || !strings.Contains(string(prompt), "task-"+tk.ID) {
		t.Errorf("提示词：%s", prompt)
	}
	c, err := ReadLog(ctx, env, tk.ID, -1, 0)
	if err != nil || !strings.Contains(c.Text, "== 收尾") || c.Running {
		t.Errorf("task log：%+v %v", c, err)
	}
	// 交回：Bounce 回队列（没有队列行）→ 沿用原执行者、原工作树，提示词带交回原因。
	if _, err := ledger.Apply(ctx, env.DB, tk.ID, ledger.Event{Kind: ledger.Bounce}, "gates", "没有 PR"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
	prompt, _ = os.ReadFile(filepath.Join(TaskDir(env.Paths.Data, tk.ID), "prompt-2.md"))
	if !strings.Contains(string(prompt), "没有 PR") {
		t.Errorf("交回原因没进提示词：%s", prompt)
	}
}

func TestFlowQuotaSwitch(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "调研"}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "codex"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
	runs, _ := workers.Runs(ctx, env.DB, tk.ID, 10)
	if len(runs) != 2 || runs[0].Worker != "codex+gpt-6-sol" || runs[1].Why != workers.WhySwitch || runs[1].Worker != "claude+opus" {
		t.Fatalf("额度用尽应换人：%+v", runs)
	}
	h, _ := ledger.History(ctx, env.DB, tk.ID, 50)
	found := false
	for _, e := range h {
		found = found || e.Kind == "quota_exhausted"
	}
	if !found {
		t.Error("没记额度用尽")
	}
	if _, err := os.Stat(filepath.Join(TaskDir(env.Paths.Data, tk.ID), "work")); err != nil {
		t.Error("没有仓库时用 work/")
	}
}

func TestFlowStopAndTell(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "长活"}, "u1")
	if r, err := Tell(ctx, env, tk.ID, "先看文档", "u1"); err != nil || r.Via != "next" {
		t.Fatalf("没在跑的捎话下次带上：%+v %v", r, err)
	}
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "kimi"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Status == ledger.Running })
	prompt, _ := os.ReadFile(filepath.Join(TaskDir(env.Paths.Data, tk.ID), "prompt-1.md"))
	if !strings.Contains(string(prompt), "先看文档") {
		t.Errorf("捎话没进提示词：%s", prompt)
	}
	// kimi 不能即时送，也不能续上：停掉带着补充重派。
	r, err := Tell(ctx, env, tk.ID, "改成 B", "u1")
	if err != nil || r.Via != "restart" {
		t.Fatalf("%+v %v", r, err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool {
		last, _ := workers.LastRun(ctx, env.DB, tk.ID)
		return last != nil && last.N == 2 && d.procOf(tk.ID) != nil
	})
	prompt, _ = os.ReadFile(filepath.Join(TaskDir(env.Paths.Data, tk.ID), "prompt-2.md"))
	if !strings.Contains(string(prompt), "改成 B") {
		t.Errorf("重派的提示词没带补充：%s", prompt)
	}
	// 停下：人把任务改成受阻，派活循环结束它的执行者，退出后不再收尾。
	if _, err := ledger.Apply(ctx, env.DB, tk.ID, ledger.Event{Kind: ledger.Set, To: ledger.Blocked}, "u1", "不做了"); err != nil {
		t.Fatal(err)
	}
	if err := d.reap(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(ledger.Task) bool { return d.procOf(tk.ID) == nil })
	if got, _ := ledger.Get(ctx, env.DB, tk.ID); got.Status != ledger.Blocked {
		t.Fatalf("应保持受阻：%s", got.Status)
	}
	// 依赖没完成不能派；写死的执行者接不了高风险。
	t2, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "后续", After: []string{tk.ID}}, "u1")
	if _, err := Enqueue(ctx, env, t2.ID, Options{}, "u1"); err == nil || !strings.Contains(err.Error(), "依赖") {
		t.Errorf("依赖：%v", err)
	}
	t3, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "高风险"}, "u1")
	if _, err := Enqueue(ctx, env, t3.ID, Options{Worker: "claude", Risk: "high"}, "u1"); err == nil || !strings.Contains(err.Error(), "接不了") {
		t.Errorf("风险：%v", err)
	}
}

// claude 的捎话即时写进标准输入：假执行者等第二条消息，回显后收尾；运行时记下送达，退出后不再续上。
func TestFlowTellStdin(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	bin := filepath.Dir(must(exec.LookPath("claude")))
	os.WriteFile(filepath.Join(bin, "claude"), []byte(`#!/bin/sh
read first
echo '{"type":"system","subtype":"init","session_id":"0123abcd-0123-0123-0123-0123456789ab"}'
read second
uuid=$(printf '%s' "$second" | sed 's/.*"uuid":"\([^"]*\)".*/\1/')
echo '{"type":"user","isReplay":true,"uuid":"'$uuid'"}'
echo '{"type":"result","is_error":false,"stop_reason":"end_turn","result":"ok"}'
cat >/dev/null
`), 0o755)
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "边做边听"}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "claude"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(ledger.Task) bool { return d.procOf(tk.ID) != nil })
	r, err := Tell(ctx, env, tk.ID, "顺手改个错别字", "u1")
	if err != nil || r.Via != "stdin" {
		t.Fatalf("%+v %v", r, err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
	runs, _ := workers.Runs(ctx, env.DB, tk.ID, 10)
	if len(runs) != 1 {
		t.Fatalf("送到了就不该再续上：%+v", runs)
	}
	h, _ := ledger.History(ctx, env.DB, tk.ID, 50)
	sent := false
	for _, e := range h {
		sent = sent || e.Kind == "tell_sent"
	}
	if !sent {
		t.Error("没记送达")
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// 服务重启后接管：新的派活实例认出还活着的执行者，任务取消后结束它。
func TestFlowAdopt(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "跨重启"}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "kimi"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(ledger.Task) bool { return d.procOf(tk.ID) != nil })
	// 旧实例的内存丢掉（模拟重启）：新 env 指针拿到新实例。
	d.retired.Store(true)
	d.mu.Lock()
	d.procs = map[string]*proc{}
	d.mu.Unlock()
	env2 := *env
	d2 := get(&env2)
	if d2 == d {
		t.Fatal("应是新实例")
	}
	if err := d2.adopt(ctx); err != nil {
		t.Fatal(err)
	}
	if d2.procOf(tk.ID) == nil {
		t.Fatal("没接管")
	}
	if _, err := ledger.Apply(ctx, env.DB, tk.ID, ledger.Event{Kind: ledger.Cancel}, "u1", ""); err != nil {
		t.Fatal(err)
	}
	if err := d2.reap(ctx); err != nil {
		t.Fatal(err)
	}
	d2.wg.Wait()
	if got, _ := ledger.Get(ctx, env.DB, tk.ID); got.Status != ledger.Cancelled {
		t.Fatalf("应保持取消：%s", got.Status)
	}
}

// 远程机器：拉起指令交给 hosts（纯数据的请求），退出码由 hosts 报回后照常收尾；代理按同一份适配器算调用。
func TestFlowRemote(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	var got Remote
	exit := make(chan int, 1)
	oldPick, oldLaunch, oldWait := pickHost, launchRemote, waitRemote
	t.Cleanup(func() { pickHost, launchRemote, waitRemote = oldPick, oldLaunch, oldWait })
	pickHost = func(context.Context, *app.Env, HostNeed, string) (HostChoice, error) {
		return HostChoice{Kind: "run", Host: "h2"}, nil
	}
	launchRemote = func(_ context.Context, _ *app.Env, host string, r Remote) (int, int, error) {
		got = r
		os.WriteFile(r.Log, []byte(`{"type":"result","is_error":false,"result":"远程做完了"}`+"\n"), 0o600)
		return 1, 4242, nil
	}
	waitRemote = func(context.Context, *app.Env, string, int) (int, error) { return <-exit, nil }
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "远程活", Repo: "owner/name"}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "claude"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Status == ledger.Running })
	if got.Tool != "claude" || got.Repo != "https://github.com/owner/name.git" || got.Branch != "task-"+tk.ID || got.Base != "main" ||
		!strings.Contains(got.Request.Prompt, "远程活") || got.Request.Live || got.Request.Dir != "" {
		t.Fatalf("拉起指令：%+v", got)
	}
	exit <- 0
	x := waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
	if x.Host != "h2" {
		t.Fatalf("机器：%+v", x)
	}
	body, _, _ := gatesLast(ctx, env, tk.ID, "result")
	if body != "远程做完了" {
		t.Errorf("最后回复：%q", body)
	}
	// 代理那边：同一份适配器，提示词从内存走标准输入。
	a, ok := adapterFor("claude")
	if !ok {
		t.Fatal("claude")
	}
	req := got.Request
	req.Dir = t.TempDir()
	spec, err := a.Spec(req, map[string]string{"PATH": os.Getenv("PATH")})
	if err != nil || spec.Stdin == nil || !strings.HasSuffix(spec.Path, "claude") {
		t.Fatalf("代理算的调用：%+v %v", spec, err)
	}
	if _, ok := adapterFor("../x"); ok {
		t.Error("不合法的工具名应拒绝")
	}
}

func gatesLast(ctx context.Context, env *app.Env, task, kind string) (string, bool, error) {
	var body string
	err := env.DB.QueryRowContext(ctx, `SELECT body FROM task_events WHERE task = ? AND kind = ? ORDER BY id DESC LIMIT 1`, task, kind).Scan(&body)
	return body, err == nil, err
}
