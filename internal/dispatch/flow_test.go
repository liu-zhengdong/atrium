package dispatch

import (
	"cmp"
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
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/watch"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 假执行者：claude 读第一条消息、打会话与收尾、等标准输入关掉才退；codex 报额度用尽；kimi 一直睡。
var fakes = map[string]string{
	"claude": `#!/bin/sh
read first
echo '{"type":"system","subtype":"init","session_id":"0123abcd-0123-0123-0123-0123456789ab","model":"claude-opus-5-5"}'
echo "worker=$ATRIUM_WORKER task=$ATRIUM_TASK secret=${DEMO_TOKEN:-none} home=${ANTHROPIC_API_KEY:-clean} cwd=$(pwd -P)"
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
echo "started server=$ATRIUM_SERVER token=${ATRIUM_WORKER_TOKEN:+yes}"
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
	t.Setenv("HOME", dir) // 假主目录：全局原则读这里的 AGENTS.md，不读开发者本机的
	os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("先给结论"), 0o600)
	t.Setenv("ANTHROPIC_API_KEY", "leak")
	db, err := store.Open(filepath.Join(dir, "data", "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	env := &app.Env{DB: db, Paths: config.Paths{Data: filepath.Join(dir, "data")}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Pause: &pause.Store{DB: db}}
	// 执行者令牌以用户令牌为签名钥匙：服务启动时写好，测试里自己写。
	if err := os.WriteFile(env.Paths.Token(), []byte("test-user-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	// 不读开发者本机的额度与机器：只用本机、没有额度数据。
	// 假的内置工具在 PATH 上：自动挑人时当用户的服务挑它们（换人重派要用）。
	oldPick, oldIsolated := pickHost, isolated
	pickHost = func(ctx context.Context, env *app.Env, need HostNeed, pinned string) (HostChoice, error) {
		marks, err := workers.Marks(ctx, env.DB, store.Now())
		if err != nil {
			return HostChoice{}, err
		}
		clis := map[string]hosts.CLI{}
		for _, tool := range workers.Tools {
			clis[tool] = hosts.CLI{Installed: true}
		}
		clis["fake"] = hosts.CLI{Installed: true}
		return hosts.Choose([]hosts.Candidate{{ID: LocalHost, Kind: "local", CLIs: clis, Marks: marks}}, need, pinned), nil
	}
	isolated = func(*app.Env) bool { return false }
	t.Cleanup(func() { pickHost, isolated = oldPick, oldIsolated })
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
	if !strings.Contains(string(prompt), "改 README") || !strings.Contains(string(prompt), "task-"+tk.ID) ||
		!strings.Contains(string(prompt), "## 用户的全局原则（~/AGENTS.md，优先于部门要点）\n\n先给结论\n") {
		t.Errorf("提示词：%s", prompt)
	}
	c, err := ReadLog(ctx, env, tk.ID, -1, 0)
	if err != nil || !strings.Contains(c.Text, `"type":"result"`) || c.Running {
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
	if runs, _ := workers.Runs(ctx, env.DB, tk.ID, 10); len(runs) != 2 || runs[1].Why != workers.WhyBounce || runs[1].Cause != "交付检查未通过" {
		t.Errorf("交回后的拉起缘由应记交回：%+v", runs)
	}
}

// 有工作地点：执行者在原文件夹里拉起，不建工作树、不建 work/；文件夹不在就派不出去。
func TestFlowInPlace(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	place, _ := filepath.EvalSymlinks(t.TempDir())
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "写文章", Dir: place}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "claude"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
	run, _ := workers.LastRun(ctx, env.DB, tk.ID)
	if run == nil || run.Dir != place || run.Branch != "" {
		t.Fatalf("应在工作地点原地拉起：%+v", run)
	}
	if log, _ := os.ReadFile(run.Log); !strings.Contains(string(log), "cwd="+place+"\n") {
		t.Errorf("执行者的当前目录不是工作地点：%s", log)
	}
	for _, sub := range []string{"repo", "work"} {
		if _, err := os.Stat(filepath.Join(TaskDir(env.Paths.Data, tk.ID), sub)); !os.IsNotExist(err) {
			t.Errorf("不该建 %s：%v", sub, err)
		}
	}
	prompt, _ := os.ReadFile(filepath.Join(TaskDir(env.Paths.Data, tk.ID), "prompt-1.md"))
	if !strings.Contains(string(prompt), "原地干") || strings.Contains(string(prompt), "开 PR") {
		t.Errorf("提示词应让执行者原地干、不开 PR：%s", prompt)
	}

	gone, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "写文章", Dir: filepath.Join(place, "nosuch")}, "u1")
	if _, err := Enqueue(ctx, env, gone.ID, Options{Worker: "claude"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := ledger.Get(ctx, env.DB, gone.ID); got.Status != ledger.Blocked {
		t.Fatalf("工作地点不在应转受阻：%+v", got)
	}
}

// 执行者额度用尽：标记本机套餐到恢复时刻，直接换人；进入关卡前记下两次拉起。
func TestFlowQuotaRequeue(t *testing.T) {
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
	marks, _ := workers.Marks(ctx, env.DB, store.Now())
	if len(marks) != 1 || marks[0].Target() != "codex@"+LocalHost || marks[0].Until <= store.Now() {
		t.Fatalf("应标记本机的 codex 额度用尽：%+v", marks)
	}
	v, err := d.view(ctx, tk, "low", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Candidates {
		if c.ID == "codex" && (c.Eligible || !strings.Contains(strings.Join(c.Refusals, "、"), "额度用尽")) {
			t.Errorf("挑执行者应避开额度用尽的组合：%+v", c)
		}
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
	runs, _ := workers.Runs(ctx, env.DB, tk.ID, 10)
	if len(runs) != 2 || runs[0].Worker != "codex" || runs[1].Worker == "codex" {
		t.Fatalf("额度用尽应换人重派：%+v", runs)
	}
	stats, err := workers.Stats(ctx, env.DB)
	if err != nil {
		t.Fatal(err)
	}
	if s := stats["codex"]; len(s) != 1 || s[0].Outcome != workers.OutQuota || s[0].Task != tk.ID || s[0].Model != "" {
		t.Errorf("这次拉起应记额度失败（codex 不报模型）：%+v", s)
	}
	if s := stats[workers.Combo(runs[1].Worker)]; len(s) != 1 || s[0].Outcome != workers.OutOK || s[0].Model != "claude-opus-5-5" {
		t.Errorf("换上的执行者应记交付，带上它报的模型：%+v", s)
	}
	if _, err := os.Stat(filepath.Join(TaskDir(env.Paths.Data, tk.ID), "work")); err != nil {
		t.Error("没有仓库时用 work/")
	}
}

// watch 在执行者还活着时从日志读到额度用尽：先转失败再 Requeue，同样标记「工具+模型@机器」。
func TestWatchQuotaMarks(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "grok"), []byte("#!/bin/sh\necho 'Error: HTTP/1.1 429 Too Many Requests'\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "调研"}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "grok"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Status == ledger.Running })
	run, _ := workers.LastRun(ctx, env.DB, tk.ID)
	for i := 0; i < 100; i++ {
		if b, _ := os.ReadFile(run.Log); strings.Contains(string(b), "429") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if _, err := ledger.Apply(ctx, env.DB, tk.ID, ledger.Event{Kind: ledger.ExitFail}, "runtime", "额度用尽"); err != nil {
		t.Fatal(err)
	}
	if err := Requeue(ctx, env, tk.ID, watch.Why{Signal: watch.SigQuota, Worker: run.Worker}); err != nil {
		t.Fatal(err)
	}
	marks, _ := workers.Marks(ctx, env.DB, store.Now())
	if len(marks) != 1 || marks[0].Target() != run.Worker+"@"+LocalHost || marks[0].Until <= store.Now() {
		t.Fatalf("watch 读到额度用尽也应标记 %s：%+v", run.Worker, marks)
	}
}

// 执行者报没登录：标记本机的这个工具，直接换人并避开它。
func TestFlowLoginRequeue(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "grok"), []byte("#!/bin/sh\necho 'Not signed in'\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	if err := hosts.EnsureLocal(ctx, env.DB, hosts.Info{}); err != nil {
		t.Fatal(err)
	}
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "审阅"}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "grok"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
	marks, _ := workers.Marks(ctx, env.DB, store.Now())
	if len(marks) != 1 || marks[0].Target() != "grok@"+LocalHost || marks[0].Until != 0 {
		t.Fatalf("本机的 grok 应标没登录、等人处理：%+v", marks)
	}
	v, err := d.view(ctx, tk, "low", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Candidates {
		if strings.HasPrefix(c.ID, "grok") && (c.Eligible || !strings.Contains(strings.Join(c.Refusals, "、"), "没登录")) {
			t.Errorf("挑执行者应避开没登录的 grok：%+v", c)
		}
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
	runs, _ := workers.Runs(ctx, env.DB, tk.ID, 10)
	if len(runs) != 2 || runs[0].Worker != "grok" || strings.HasPrefix(runs[1].Worker, "grok") {
		t.Fatalf("没登录应换人重派：%+v", runs)
	}
}

func TestFlowStopAndTell(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "长活"}, "u1")
	if r, err := Tell(ctx, env, tk.ID, "先看文档", "u1"); err != nil || r.Via != "next" {
		t.Fatalf("没在跑的补充说明下次带上：%+v %v", r, err)
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
		t.Errorf("补充说明没进提示词：%s", prompt)
	}
	// kimi 不能即时送，也不能继续：停掉带着补充重派。
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
	// 停下：人把任务改成受阻，分派任务循环结束它的执行者，退出后不再收尾。
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
	// 依赖还没完成（受阻还能解开）照样进队列等；依赖失败了当场拒绝；写死的执行者接不了高风险。
	t2, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "后续", After: []string{tk.ID}}, "u1")
	if got, err := Enqueue(ctx, env, t2.ID, Options{}, "u1"); err != nil || got.Status != ledger.Queued {
		t.Errorf("依赖没完成应进队列等：%+v %v", got, err)
	}
	tf, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "失败件"}, "u1")
	ledger.Apply(ctx, env.DB, tf.ID, ledger.Event{Kind: ledger.Set, To: ledger.Failed}, "u1", "")
	tBad, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "后续坏件", After: []string{tf.ID}}, "u1")
	if _, err := Enqueue(ctx, env, tBad.ID, Options{}, "u1"); err == nil || !strings.Contains(err.Error(), "等不到") {
		t.Errorf("依赖失败应报错：%v", err)
	}
	// 还有没结束的子任务的父任务不派；子任务都结束后照常能派。
	tp, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "父任务"}, "u1")
	tc, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "子任务", Parent: tp.ID}, "u1")
	if _, err := Enqueue(ctx, env, tp.ID, Options{}, "u1"); err == nil || !strings.Contains(err.Error(), "子任务没结束") {
		t.Errorf("有没结束的子任务应拒：%v", err)
	}
	if got, _ := ledger.Get(ctx, env.DB, tp.ID); got.Status != ledger.Todo {
		t.Errorf("被拒后应仍是 todo：%s", got.Status)
	}
	ledger.Apply(ctx, env.DB, tc.ID, ledger.Event{Kind: ledger.Set, To: ledger.Cancelled}, "u1", "")
	if _, err := Enqueue(ctx, env, tp.ID, Options{}, "u1"); err != nil {
		t.Errorf("子任务都结束后应能派：%v", err)
	}
	t3, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "高风险"}, "u1")
	if _, err := Enqueue(ctx, env, t3.ID, Options{Worker: "claude", Risk: "high"}, "u1"); err == nil || !strings.Contains(err.Error(), "接不了") {
		t.Errorf("风险：%v", err)
	}
}

// claude 的补充说明即时写进标准输入：假执行者等第二条消息，回显后收尾；运行时记下送达，退出后不再继续。
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
		t.Fatalf("送到了就不该再继续：%+v", runs)
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

// 执行者在跑时改说明：当一次补充说明走 Tell（kimi 停掉带着补充重派），重派的提示词里有新说明。
func TestFlowEditDetailTells(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	old := ledger.Tell
	hook(env)
	t.Cleanup(func() { ledger.Tell = old })
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "长活", Detail: "做 A"}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "kimi"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(ledger.Task) bool { return d.procOf(tk.ID) != nil })
	detail := "改做 B"
	if _, err := ledger.Edit(ctx, env.DB, tk.ID, ledger.Patch{Detail: &detail}, "u1"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(ledger.Task) bool {
		last, _ := workers.LastRun(ctx, env.DB, tk.ID)
		return last != nil && last.N == 2 && d.procOf(tk.ID) != nil
	})
	prompt, _ := os.ReadFile(filepath.Join(TaskDir(env.Paths.Data, tk.ID), "prompt-2.md"))
	if !strings.Contains(string(prompt), "说明已改，以最新说明为准") || !strings.Contains(string(prompt), "改做 B") {
		t.Errorf("重派的提示词应带改过的说明：%s", prompt)
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// 服务重启后继续跟进：新的分派任务实例认出还活着的执行者，任务取消后结束它。
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
		t.Fatal("没继续跟进")
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
// 本机克隆的仓库派到远程时换成它 origin 的 GitHub 地址；工作树登记记那台的机器与目录。
func TestFlowRemote(t *testing.T) {
	clone := t.TempDir()
	for _, args := range [][]string{{"init", "--quiet", clone}, {"-C", clone, "remote", "add", "origin", "git@github.com:owner/name.git"}} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v：%v %s", args, err, out)
		}
	}
	for _, repo := range []string{"owner/name", clone} {
		t.Run(filepath.Base(repo), func(t *testing.T) { flowRemote(t, repo) })
	}
}

func flowRemote(t *testing.T, repo string) {
	env, d := setup(t)
	ctx := context.Background()
	var got Remote
	exit := make(chan int, 1)
	oldPick, oldLaunch, oldWait := pickHost, launchRemote, waitRemote
	t.Cleanup(func() { pickHost, launchRemote, waitRemote = oldPick, oldLaunch, oldWait })
	var need HostNeed
	pickHost = func(_ context.Context, _ *app.Env, n HostNeed, _ string) (HostChoice, error) {
		need = n
		return HostChoice{Kind: "run", Host: "h2"}, nil
	}
	launchRemote = func(_ context.Context, _ *app.Env, host string, r Remote) (int, int, string, error) {
		got = r
		os.WriteFile(r.Log, []byte(`{"type":"result","is_error":false,"result":"远程做完了"}`+"\n"), 0o600)
		return 1, 4242, "/agent/repos/owner-name-" + r.Task, nil
	}
	waitRemote = func(context.Context, *app.Env, string, int) (hosts.Exit, error) {
		code := <-exit
		return hosts.Exit{Code: &code}, nil
	}
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "远程活", Repo: repo}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "claude"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Status == ledger.Running })
	if need.Repo != "owner/name" || need.LocalOnly != "" {
		t.Fatalf("挑机器的要求：%+v", need)
	}
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
	if wt, _, _ := gatesLast(ctx, env, tk.ID, "worktree"); wt != `{"host":"h2","dir":"/agent/repos/owner-name-`+tk.ID+`"}` {
		t.Errorf("工作树登记：%s", wt)
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

// 本机克隆读不出 GitHub 上的 origin、有工作地点（本机文件夹）、体验巡检的一轮：只派本机。
func TestHostNeedLocalOnly(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	claude := workers.Spec{Tool: "claude"}
	if n, err := hostNeed(ctx, db, claude, ledger.Task{Dir: t.TempDir()}); err != nil || n.LocalOnly == "" {
		t.Errorf("有工作地点应只派本机：%+v %v", n, err)
	}
	plain := t.TempDir()
	if out, err := exec.Command("git", "init", "--quiet", plain).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	for repo, local := range map[string]bool{"": false, "owner/name": false, plain: true} {
		n, err := hostNeed(ctx, db, claude, ledger.Task{Repo: repo})
		if err != nil || (n.LocalOnly != "") != local {
			t.Errorf("%q：%+v %v", repo, n, err)
		}
	}
	old := agenda.Enqueue
	agenda.Enqueue = func(context.Context, *app.Env, string, string) error { return nil }
	t.Cleanup(func() { agenda.Enqueue = old })
	d, err := org.Add(ctx, db, org.NewDept{Name: "公司"})
	if err != nil {
		t.Fatal(err)
	}
	x, err := agenda.AddSchedule(ctx, db, agenda.NewSchedule{Org: d.ID, Title: "巡检", Kind: "patrol", Every: "7d"}, "u1", store.Now(), time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	tk, err := agenda.RunNow(ctx, &app.Env{DB: db}, x.ID, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if n, err := hostNeed(ctx, db, claude, tk); err != nil || n.LocalOnly == "" {
		t.Errorf("体验巡检的一轮应只派本机：%+v %v", n, err)
	}
}

// 换人时给新执行者挑机器：上一轮那台接得了就留下，接不了（没装、没登录、标了不可用）另挑，都接不了报冲突。
func TestSwitchHost(t *testing.T) {
	_, d := setup(t)
	ctx := context.Background()
	refuse := map[string]string{} // 机器 → 接不了的原因
	var needs []HostNeed
	pickHost = func(_ context.Context, _ *app.Env, n HostNeed, pinned string) (HostChoice, error) {
		needs = append(needs, n)
		for _, h := range []string{"h1", "h3"} {
			if (pinned == "" || pinned == h) && refuse[h] == "" {
				return HostChoice{Kind: "run", Host: h}, nil
			}
		}
		return HostChoice{Kind: "refuse", Reason: refuse[cmp.Or(pinned, "h3")]}, nil
	}
	w := workers.Spec{Tool: "agy", Model: "gemini-3.8-flash-high"}
	cases := []struct {
		name, prev string
		refuse     map[string]string
		want       string
		err        bool
	}{
		{"上一轮那台接得了", "h3", nil, "h3", false},
		{"上一轮那台没登录就另挑", "h3", map[string]string{"h3": "h3 上的 agy 没登录"}, "h1", false},
		{"都接不了", "h1", map[string]string{"h1": "h1 上没装 agy", "h3": "h3 上的 agy+gemini-3.8-flash-high 不可用"}, "", true},
	}
	for _, c := range cases {
		refuse, needs = c.refuse, nil
		if refuse == nil {
			refuse = map[string]string{}
		}
		host, err := d.switchHost(ctx, ledger.Task{}, w, c.prev)
		if host != c.want || (err != nil) != c.err || needs[0].Tool != "agy" || needs[0].Model != w.Model {
			t.Errorf("%s：%q %v %+v", c.name, host, err, needs)
		}
	}
}

func gatesLast(ctx context.Context, env *app.Env, task, kind string) (string, bool, error) {
	var body string
	err := env.DB.QueryRowContext(ctx, `SELECT body FROM task_events WHERE task = ? AND kind = ? ORDER BY id DESC LIMIT 1`, task, kind).Scan(&body)
	return body, err == nil, err
}

// 依赖没完成的任务先进队列等；依赖完成（done）后分派任务循环照常拉起它。
func TestFlowDepsAutoDispatch(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	repo := gitRepo(t)
	t1, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "前序活", Repo: repo}, "u1")
	t2, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "后续活", Repo: repo, After: []string{t1.ID}}, "u1")
	if _, err := Enqueue(ctx, env, t2.ID, Options{Worker: "claude"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if _, err := Enqueue(ctx, env, t1.ID, Options{Worker: "claude"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, t1.ID, func(x ledger.Task) bool { return x.Status == ledger.Running })
	if got, _ := ledger.Get(ctx, env.DB, t2.ID); got.Status != ledger.Queued {
		t.Fatalf("t1 还没完成，t2 应留在队列里：%s", got.Status)
	}
	if _, err := ledger.Apply(ctx, env.DB, t1.ID, ledger.Event{Kind: ledger.Set, To: ledger.Done}, "u1", "前序完成"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, t2.ID, func(x ledger.Task) bool { return x.Status == ledger.Running })
}

// 依赖失败或取消：等着的任务不再派，转受阻（去掉队列行），要处理地发给处理人。
func TestFlowDepsBroken(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	for _, q := range []string{
		`INSERT INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0)`,
		`INSERT INTO departments (id, parent, name, leader, created_at, updated_at) VALUES ('o1', NULL, '部门', 'a1', 0, 0)`,
	} {
		if _, err := env.DB.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	for _, to := range []ledger.Status{ledger.Failed, ledger.Cancelled} {
		first, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "前序", Org: "o1"}, "a1")
		next, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "后续", Org: "o1", After: []string{first.ID}}, "a1")
		if _, err := Enqueue(ctx, env, next.ID, Options{Worker: "claude"}, "a1"); err != nil {
			t.Fatal(err)
		}
		if _, err := ledger.Apply(ctx, env.DB, first.ID, ledger.Event{Kind: ledger.Set, To: to}, "u1", ""); err != nil {
			t.Fatal(err)
		}
		if err := d.pump(ctx); err != nil {
			t.Fatal(err)
		}
		if got, _ := ledger.Get(ctx, env.DB, next.ID); got.Status != ledger.Blocked {
			t.Fatalf("依赖%s后应转受阻：%s", to, got.Status)
		}
		var rows int
		env.DB.QueryRowContext(ctx, `SELECT count(*) FROM queue WHERE task = ?`, next.ID).Scan(&rows)
		var target, level string
		err := env.DB.QueryRowContext(ctx, `SELECT target, level FROM events WHERE task = ? AND kind = ? ORDER BY id DESC LIMIT 1`,
			next.ID, events.TaskStatus).Scan(&target, &level)
		if rows != 0 || err != nil || target != "a1" || level != events.Act {
			t.Fatalf("依赖%s：队列行 %d，事件 %s %s %v", to, rows, target, level, err)
		}
	}
}

// 失败后改派：入队当场把执行者改成这一轮指定的、机器改成指定的（没指定留空）；排队中再 task run 被拒，原队列行不动。
func TestEnqueueSetsWorker(t *testing.T) {
	env, _ := setup(t)
	ctx := context.Background()
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "改派"}, "u1")
	prev, host := "agy+gemini-3.8-flash-high", LocalHost
	if err := ledger.SetFacts(ctx, env.DB, tk.ID, ledger.Facts{Worker: &prev, Host: &host}, "u1"); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.Apply(ctx, env.DB, tk.ID, ledger.Event{Kind: ledger.Set, To: ledger.Failed}, "u1", "上一轮失败"); err != nil {
		t.Fatal(err)
	}
	got, err := Enqueue(ctx, env, tk.ID, Options{Worker: "claude"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != ledger.Queued || got.Worker != "claude+opus" || got.Host != "" {
		t.Fatalf("入队后应显示这一轮的执行者、机器清空：%+v", got)
	}
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "kimi"}, "u1"); err == nil {
		t.Fatal("排队中不能再派")
	}
	list, err := queued(ctx, env.DB)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || !list[0].Row || list[0].Opts.Worker != "claude+opus" {
		t.Fatalf("被拒的 task run 不该动原队列行：%+v", list)
	}
	if got, _ := ledger.Get(ctx, env.DB, tk.ID); got.Worker != "claude+opus" {
		t.Fatalf("被拒的 task run 不该改执行者：%+v", got)
	}
	// 自动挑：执行者留空，拉起时再写。
	ledger.Apply(ctx, env.DB, tk.ID, ledger.Event{Kind: ledger.Set, To: ledger.Failed}, "u1", "")
	if got, err := Enqueue(ctx, env, tk.ID, Options{}, "u1"); err != nil || got.Worker != "" {
		t.Fatalf("自动挑时执行者应留空：%+v %v", got, err)
	}
}

// Lost 即使日志声称成功也不能进入交付检查，沿现有临时退出路径有界重试。
func TestRemoteLostRetries(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	oldLaunch, oldWait := launchRemote, waitRemote
	t.Cleanup(func() { launchRemote, waitRemote = oldLaunch, oldWait })
	launchRemote = func(_ context.Context, _ *app.Env, _ string, r Remote) (int, int, string, error) {
		return 2, 4242, t.TempDir(), nil
	}
	waitRemote = func(context.Context, *app.Env, string, int) (hosts.Exit, error) { return hosts.Exit{Lost: true}, nil }
	tk, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "丢失远程轮次", Dir: t.TempDir()}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.Apply(ctx, env.DB, tk.ID, ledger.Event{Kind: ledger.Enqueue}, "u1", ""); err != nil {
		t.Fatal(err)
	}
	tk, err = ledger.Get(ctx, env.DB, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	w, err := workers.Resolve(ctx, env.DB, "claude")
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "run.log")
	os.WriteFile(log, []byte(`{"type":"result","is_error":false,"result":"ok"}`), 0o600)
	run := workers.Run{N: 1, Worker: "claude", Host: "h2", PID: 4242, Log: log, Dir: tk.Dir, Why: workers.WhyFirst}
	if err := d.record(ctx, tk, run); err != nil {
		t.Fatal(err)
	}
	p := &proc{task: tk.ID, run: run, adapter: w.Adapter, remote: true}
	code := d.remoteWaiter(p, 1)()
	// 不启动后台等待：重试拉起成功后立即退休，避免假退出无限连跑。
	d.retired.Store(true)
	if err := d.exited(ctx, p, code); err != nil {
		t.Fatal(err)
	}
	d.wg.Wait()
	last, err := workers.LastRun(ctx, env.DB, tk.ID)
	if err != nil || last.N != 2 || last.Why != workers.WhySame {
		t.Fatalf("未重试：%+v %v", last, err)
	}
	history, err := ledger.History(ctx, env.DB, tk.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, h := range history {
		if h.Kind == "exit_ok" {
			t.Fatal("Lost 进了交付检查")
		}
		if h.Kind == "exit" {
			var x workers.Exit
			if err := jsonUnmarshal(h.Body, &x); err != nil {
				t.Fatal(err)
			}
			if x.Outcome != workers.OutFail || !strings.Contains(x.Reason, "退出不明") {
				t.Fatalf("错误退出记录：%+v", x)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("缺少退出记录")
	}
	marks, err := workers.Marks(ctx, env.DB, store.Now())
	if err != nil || len(marks) != 0 {
		t.Fatalf("不应标不可用：%+v %v", marks, err)
	}
}
