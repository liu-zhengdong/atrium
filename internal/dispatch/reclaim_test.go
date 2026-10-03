package dispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/gates/fakegh"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/merge"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func reclaimRig(t *testing.T) (*dispatcher, *fakegh.GH, context.Context) {
	t.Helper()
	data := t.TempDir()
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(data, "gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("NO_LEADERS", "1")
	t.Setenv("HOME", data)
	t.Setenv("USERPROFILE", data)
	db, err := store.Open(filepath.Join(data, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	env := &app.Env{DB: db, Paths: config.Paths{Data: data}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Pause: &pause.Store{DB: db}}
	if err := os.WriteFile(env.Paths.Token(), []byte("isolated-test-token"), 0600); err != nil {
		t.Fatal(err)
	}
	return get(env), fakegh.New(t, nil), ctx
}

func reclaimTask(t *testing.T, d *dispatcher, gh *fakegh.GH, ctx context.Context) (ledger.Task, string) {
	t.Helper()
	tk, err := ledger.Add(ctx, d.env.DB, ledger.NewTask{Title: "回收验证", Repo: gh.Work}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	dir, _, err := Workdir(ctx, d.env.Paths.Data, tk.ID, tk.Repo, "")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(gates.Worktree{Host: LocalHost, Dir: dir})
	if err := ledger.Record(ctx, d.env.DB, tk.ID, gates.KindWorktree, actor, string(body)); err != nil {
		t.Fatal(err)
	}
	gh.Write(dir, "node_modules/cache", "依赖")
	gh.Write(dir, ".venv/cache", "依赖")
	gh.Write(TaskDir(d.env.Paths.Data, tk.ID), "prompt-1.md", "提示词")
	gh.Write(TaskDir(d.env.Paths.Data, tk.ID), "run-1.log", "日志\n")
	temp := filepath.Join(TaskDir(d.env.Paths.Data, tk.ID), "tmp")
	gh.Write(temp, "cache", "临时文件")
	if err := os.Chmod(filepath.Join(temp, "cache"), 0400); err != nil {
		t.Fatal(err)
	}
	return tk, dir
}

func applyReclaim(t *testing.T, d *dispatcher, ctx context.Context, id string, e ledger.Event) ledger.Task {
	t.Helper()
	tk, err := ledger.Apply(ctx, d.env.DB, id, e, "u1", "验证")
	if err != nil {
		t.Fatal(err)
	}
	return tk
}

// 真 SQLite、真 Git 与本地 bare 远端；三种结束路径均交给同一个生命周期扫描回收。
func TestReclaimEndingsAndReopen(t *testing.T) {
	for _, ending := range []string{"取消", "不合入验收完成", "合入"} {
		t.Run(ending, func(t *testing.T) {
			d, gh, ctx := reclaimRig(t)
			tk, dir := reclaimTask(t, d, gh, ctx)
			gh.Write(dir, "result.txt", "已推送的改动")
			gh.Must(dir, "add", "result.txt")
			gh.Must(dir, "commit", "--quiet", "-m", "交付")
			gh.Must(dir, "push", "--quiet", "origin", Branch(tk.ID))
			switch ending {
			case "取消":
				applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Cancel})
			case "不合入验收完成":
				for _, e := range []ledger.Event{{Kind: ledger.Enqueue}, {Kind: ledger.Start}, {Kind: ledger.ExitOK}, {Kind: ledger.GatePass, AcceptBy: "user"}, {Kind: ledger.Accept}} {
					applyReclaim(t, d, ctx, tk.ID, e)
				}
			case "合入":
				n := gh.Open(Branch(tk.ID), "")
				if _, err := ledger.Edit(ctx, d.env.DB, tk.ID, ledger.Patch{Repo: &gh.Repo}, "u1"); err != nil {
					t.Fatal(err)
				}
				if _, err := merge.Deliver(ctx, d.env.DB, gh, tk.ID, merge.Body{PR: "https://github.com/" + gh.Repo + "/pull/" + fmt.Sprint(n)}, "u1"); err != nil {
					t.Fatal(err)
				}
				q := merge.Queue{DB: d.env.DB, Pause: d.env.Pause, R: gh, Log: d.env.Log, Dir: filepath.Join(d.env.Paths.Data, "merge")}
				if err := q.Drain(ctx); err != nil {
					t.Fatal(err)
				}
				got, err := ledger.Get(ctx, d.env.DB, tk.ID)
				if err != nil || got.Status != ledger.Done {
					t.Fatalf("合入：%+v %v", got, err)
				}
			}
			stop := runReclaimLoop(t, d, ctx)
			waitReclaim(t, ctx, func() bool {
				_, found, err := gates.Last(ctx, d.env.DB, tk.ID, reclaimedKind)
				return err == nil && found
			})
			stop()
			if _, err := os.Stat(dir); !os.IsNotExist(err) {
				t.Fatalf("工作树仍在：%v", err)
			}
			if out := gh.Must(gh.Work, "branch", "--list", Branch(tk.ID)); out != "" {
				t.Fatalf("分支仍在：%s", out)
			}
			for _, name := range []string{"prompt-1.md", "run-1.log"} {
				if _, err := os.Stat(filepath.Join(TaskDir(d.env.Paths.Data, tk.ID), name)); err != nil {
					t.Fatal(err)
				}
			}
			if err := d.reclaim(ctx); err != nil {
				t.Fatal(err)
			}
			applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Set, To: ledger.Todo})
			// 合入的 Deliver 会把 repo 换成 slug；沿用实际 clone 验证重建入口，无外网。
			rebuilt, _, err := Workdir(ctx, d.env.Paths.Data, tk.ID, gh.Work, "")
			if err != nil {
				t.Fatal(err)
			}
			b, err := os.ReadFile(filepath.Join(rebuilt, "result.txt"))
			if err != nil || string(b) != "已推送的改动" {
				t.Fatalf("重开丢了已推送改动：%s %v", b, err)
			}
			if _, err := ledger.Edit(ctx, d.env.DB, tk.ID, ledger.Patch{Repo: &gh.Work}, "u1"); err != nil {
				t.Fatal(err)
			}
			// 测试二进制充当执行者，实际分派任务、拉起、退出，不调用模型。
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", filepath.Dir(exe)+string(os.PathListSeparator)+os.Getenv("PATH"))
			quoted, _ := json.Marshal(filepath.Base(exe))
			source := "---\nprotocol: cli\ncommand: " + string(quoted) + "\nargs: [\"--reclaim-fake-worker\", \"{prompt}\"]\ndone_match: '^DONE$'\n---\n"
			if _, err := workers.SaveProfile(ctx, d.env.DB, "harness/reclaimfake", workers.Edit{Source: &source}, "u1"); err != nil {
				t.Fatal(err)
			}
			oldPick := pickHost
			pickHost = func(context.Context, *app.Env, HostNeed, string) (HostChoice, error) {
				return HostChoice{Kind: "run", Host: LocalHost}, nil
			}
			t.Cleanup(func() { pickHost = oldPick })
			if _, err := Enqueue(ctx, d.env, tk.ID, Options{Worker: "reclaimfake"}, "u1"); err != nil {
				t.Fatal(err)
			}
			stop = runReclaimLoop(t, d, ctx)
			t.Cleanup(func() {
				if t.Failed() {
					got, _ := ledger.Get(ctx, d.env.DB, tk.ID)
					history, _ := ledger.History(ctx, d.env.DB, tk.ID, 5)
					t.Logf("重开现场：%+v，经历：%+v", got, history)
				}
			})
			waitReclaim(t, ctx, func() bool {
				got, err := ledger.Get(ctx, d.env.DB, tk.ID)
				return err == nil && got.Stage == ledger.StageGate
			})
			stop()
			if b, err := os.ReadFile(filepath.Join(rebuilt, "continued.txt")); err != nil || string(b) != "继续干" {
				t.Fatalf("重开执行者未继续工作：%s %v", b, err)
			}
			t.Logf("%s：工作树与本地分支已回收，prompt/run 保留，重开已恢复改动并继续写入", ending)
		})
	}
}

func TestMain(m *testing.M) {
	if filepath.Base(os.Args[0]) == "pi" || filepath.Base(os.Args[0]) == "pi.exe" {
		os.Exit(recoveryPi())
	}
	if len(os.Args) > 2 && os.Args[1] == "--recovery-fake-worker" {
		os.Exit(recoveryCLI(os.Args[2]))
	}
	if filepath.Base(os.Args[0]) == "git" && os.Getenv("RECLAIM_TEST_GIT") != "" {
		os.Exit(reclaimGitBarrier())
	}
	if len(os.Args) > 1 && os.Args[1] == "--continue-pr-worker" {
		os.Exit(continuePRWorker())
	}
	if len(os.Args) > 1 && (os.Args[1] == "--reclaim-fake-worker" || os.Args[1] == "--reclaim-wait-worker") {
		if err := os.WriteFile("continued.txt", []byte("继续干"), 0600); err != nil {
			os.Exit(1)
		}
		temp := os.Getenv("TMPDIR")
		if temp == "" || os.Getenv("TMP") != temp || os.Getenv("TEMP") != temp {
			os.Exit(2)
		}
		// 打回会复用临时目录；假执行者重建自己的只读缓存，不能直接覆盖 0400 文件。
		if err := os.Remove(filepath.Join(temp, "readonly")); err != nil && !os.IsNotExist(err) {
			os.Exit(3)
		}
		if err := os.WriteFile(filepath.Join(temp, "readonly"), []byte("只读缓存"), 0o400); err != nil {
			os.Exit(3)
		}
		if os.Args[1] == "--reclaim-wait-worker" {
			time.Sleep(time.Minute)
		}
		fmt.Println("DONE\n交付结论：完成")
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func runReclaimLoop(t *testing.T, d *dispatcher, parent context.Context) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(parent)
	d.retired.Store(false)
	done := make(chan error, 1)
	go func() { done <- Run(ctx, d.env) }()
	stopped := false
	stop := func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("隔离分派任务循环：%v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("隔离分派任务循环未退出")
		}
	}
	t.Cleanup(stop)
	return stop
}

func waitReclaim(t *testing.T, ctx context.Context, ok func() bool) {
	t.Helper()
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	for !ok() {
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-deadline.C:
			t.Fatal("等待回收或重开执行者超时")
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func TestReclaimRuleAndOwnership(t *testing.T) {
	for _, status := range ledger.Statuses {
		t.Run(string(status), func(t *testing.T) {
			d, gh, ctx := reclaimRig(t)
			tk, dir := reclaimTask(t, d, gh, ctx)
			switch status {
			case ledger.Queued:
				applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Enqueue})
			case ledger.Running:
				applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Enqueue})
				applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Start})
			case ledger.Todo:
			case ledger.Draft:
				dept, err := org.Add(ctx, d.env.DB, org.NewDept{Name: "回收状态"})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := ledger.Edit(ctx, d.env.DB, tk.ID, ledger.Patch{Org: &dept.ID}, "u1"); err != nil {
					t.Fatal(err)
				}
				applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Set, To: status})
			default:
				applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Set, To: status})
			}
			if err := d.reclaim(ctx); err != nil {
				t.Fatal(err)
			}
			_, tempErr := os.Stat(filepath.Join(TaskDir(d.env.Paths.Data, tk.ID), "tmp"))
			if Reclaimable(status) {
				if !os.IsNotExist(tempErr) {
					t.Fatal("临时目录未回收", tempErr)
				}
			} else if tempErr != nil {
				t.Fatal("可续跑任务临时目录被删", tempErr)
			}
			_, err := os.Stat(dir)
			if status == ledger.Done || status == ledger.Cancelled {
				if !os.IsNotExist(err) {
					t.Fatal("未回收")
				}
			} else if err != nil {
				t.Fatalf("可续跑任务工作树被删：%v", err)
			}
		})
	}
}

func TestReclaimPaginationAndExternalDirectory(t *testing.T) {
	d, gh, ctx := reclaimRig(t)
	tk, err := ledger.Add(ctx, d.env.DB, ledger.NewTask{Title: "分页补清", Repo: gh.Work}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	external := t.TempDir()
	remoteBody, _ := json.Marshal(gates.Worktree{Host: "h2", Dir: filepath.Join(t.TempDir(), "repo")})
	if err := ledger.Record(ctx, d.env.DB, tk.ID, gates.KindWorktree, actor, string(remoteBody)); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(gates.Worktree{Host: LocalHost, Dir: filepath.Join(d.env.Paths.Data, "tasks", tk.ID, "repo")})
	for i := 0; i < 105; i++ {
		if err := ledger.Record(ctx, d.env.DB, tk.ID, gates.KindWorktree, actor, string(body)); err != nil {
			t.Fatal(err)
		}
	}
	applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Cancel})
	for _, want := range []int{99, 105, 105} {
		if err := d.reclaim(ctx); err != nil {
			t.Fatal(err)
		}
		var got int
		if err := d.env.DB.QueryRowContext(ctx, `SELECT count(*) FROM task_events WHERE kind = ?`, reclaimedKind).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("分页标记数 %d，想要 %d", got, want)
		}
		if !d.reclaimDeferred {
			t.Fatal("前一页离线代理的待清记录丢了")
		}
	}
	ex, err := ledger.Add(ctx, d.env.DB, ledger.NewTask{Title: "指定目录"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = json.Marshal(gates.Worktree{Host: LocalHost, Dir: external})
	if err := ledger.Record(ctx, d.env.DB, ex.ID, gates.KindWorktree, actor, string(body)); err != nil {
		t.Fatal(err)
	}
	applyReclaim(t, d, ctx, ex.ID, ledger.Event{Kind: ledger.Cancel})
	if err := d.reclaim(ctx); err != nil {
		t.Fatal(err)
	}
	if _, found, err := gates.Last(ctx, d.env.DB, ex.ID, ledger.KindLoopError); err != nil || !found {
		t.Fatalf("未说明保留指定目录：%v", err)
	}
	if _, err := os.Stat(external); err != nil {
		t.Fatalf("误删手工目录：%v", err)
	}
}

func TestReclaimExitedRemoteWithoutExitEvent(t *testing.T) {
	d, _, ctx := reclaimRig(t)
	body, _ := json.Marshal(workers.Run{N: 1, Host: "h2", RemoteRun: 1})
	// 取消后的退出不进 dispatch.exited 的常规统计；以 host_runs 的退出事实判断，不能永远等一条不存在的 exit。
	pending, err := d.reclaimPending(ctx, reclaimItem{task: "t1", launch: string(body), remoteRunning: false})
	if err != nil || pending {
		t.Fatalf("远程已退出仍不让回收：%v %v", pending, err)
	}
}

func TestReclaimAfterRepoCleared(t *testing.T) {
	d, gh, ctx := reclaimRig(t)
	tk, dir := reclaimTask(t, d, gh, ctx)
	empty := ""
	if _, err := ledger.Edit(ctx, d.env.DB, tk.ID, ledger.Patch{Repo: &empty}, "u1"); err != nil {
		t.Fatal(err)
	}
	applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Cancel})
	if err := d.reclaim(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("改了任务仓库后工作树未回收：%v", err)
	}
	if out := gh.Must(gh.Work, "branch", "--list", Branch(tk.ID)); out != "" {
		t.Fatalf("任务分支未回收：%s", out)
	}
}
