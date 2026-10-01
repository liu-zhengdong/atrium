package dispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// git 的一次真实查询暂停到重排之后，固定竞争顺序，不靠 sleep 猜调度。
func reclaimGitBarrier() int {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if len(os.Args) > 1 && os.Args[1] == "symbolic-ref" {
		barrier := os.Getenv("RECLAIM_TEST_BARRIER")
		if err := os.WriteFile(filepath.Join(barrier, "entered"), nil, 0600); err != nil {
			return 2
		}
		for {
			if _, err := os.Stat(filepath.Join(barrier, "release")); err == nil {
				break
			}
			select {
			case <-ctx.Done():
				return 3
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
	out, err := run(ctx, "", os.Getenv("RECLAIM_TEST_GIT"), os.Args[1:]...)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Print(out)
	return 0
}

func TestReclaimRequeuedAfterScan(t *testing.T) {
	for _, location := range []string{"repo", "dir"} {
		for _, status := range []ledger.Status{ledger.Queued, ledger.Running} {
			t.Run(location+"/"+string(status), func(t *testing.T) {
				d, gh, ctx := reclaimRig(t)
				tk, dir := reclaimTask(t, d, gh, ctx)
				if location == "dir" {
					dir = t.TempDir()
					empty := ""
					if _, err := ledger.Edit(ctx, d.env.DB, tk.ID, ledger.Patch{Repo: &empty, Dir: &dir}, "u1"); err != nil {
						t.Fatal(err)
					}
					body, _ := json.Marshal(gates.Worktree{Host: LocalHost, Dir: dir})
					if err := ledger.Record(ctx, d.env.DB, tk.ID, gates.KindWorktree, actor, string(body)); err != nil {
						t.Fatal(err)
					}
				}
				gh.Write(dir, "user.txt", "用户原地数据")
				applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Set, To: ledger.Done})
				items, err := d.reclaimBatch(ctx)
				if err != nil || len(items) == 0 {
					t.Fatalf("扫描：%v %v", items, err)
				}
				applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Set, To: ledger.Todo})
				applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Enqueue})
				if status == ledger.Running {
					applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Start})
				}
				for _, it := range items {
					if err := d.reclaimOne(ctx, it); err != nil {
						t.Fatal(err)
					}
				}
				for _, path := range []string{filepath.Join(dir, "user.txt"), filepath.Join(TempDir(d.env.Paths.Data, tk.ID), "cache")} {
					if _, err := os.Stat(path); err != nil {
						t.Fatalf("旧扫描删了新一轮目录：%v", err)
					}
				}
				if _, found, err := gates.Last(ctx, d.env.DB, tk.ID, reclaimedKind); err != nil || found {
					t.Fatalf("跳过的旧回收被记成功：%v", err)
				}
			})
		}
	}
}

func TestReclaimFailureAfterRequeue(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("git 屏障通过符号链接调用测试二进制")
	}
	for _, status := range []ledger.Status{ledger.Queued, ledger.Running} {
		t.Run(string(status), func(t *testing.T) {
			d, gh, ctx := reclaimRig(t)
			tk, dir := reclaimTask(t, d, gh, ctx)
			// 故意伪造本实例路径下的分支归属；真 Git 必须拒绝删除。
			gh.Must(dir, "checkout", "--quiet", "-b", "other-owner")
			gh.Write(dir, "user.txt", "不能删除")
			applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Set, To: ledger.Done})
			realGit, err := platform.LookPath("git", platform.EnvMap(os.Environ()))
			if err != nil {
				t.Fatal(err)
			}
			barrier := t.TempDir()
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(exe, filepath.Join(barrier, "git")); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", barrier+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("RECLAIM_TEST_GIT", realGit)
			t.Setenv("RECLAIM_TEST_BARRIER", barrier)
			done := make(chan error, 1)
			finished := false
			go func() { done <- d.reclaim(ctx) }()
			t.Cleanup(func() {
				os.WriteFile(filepath.Join(barrier, "release"), nil, 0600)
				if !finished {
					select {
					case <-done:
					case <-time.After(10 * time.Second):
						t.Error("旧回收未退出")
					}
				}
			})
			waitReclaim(t, ctx, func() bool {
				_, err := os.Stat(filepath.Join(barrier, "entered"))
				return err == nil
			})
			applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Set, To: ledger.Todo})
			applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Enqueue})
			if status == ledger.Running {
				applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Start})
				body, _ := json.Marshal(workers.Run{N: 2, Host: LocalHost, Dir: dir})
				if err := ledger.Record(ctx, d.env.DB, tk.ID, workers.RunKind, actor, string(body)); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(filepath.Join(barrier, "release"), nil, 0600); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				finished = true
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			got, err := ledger.Get(ctx, d.env.DB, tk.ID)
			if err != nil || got.Status != status {
				t.Fatalf("旧回收覆盖新状态：got=%s want=%s err=%v", got.Status, status, err)
			}
			why, found, err := gates.Last(ctx, d.env.DB, tk.ID, ledger.KindLoopError)
			if err != nil || !found || !strings.Contains(why, "不在任务分支") {
				t.Fatalf("真实归属错误被吞：%q %v", why, err)
			}
			for _, path := range []string{filepath.Join(dir, "user.txt"), filepath.Join(TempDir(d.env.Paths.Data, tk.ID), "cache")} {
				if _, err := os.Stat(path); err != nil {
					t.Fatalf("伪造归属目录被删：%v", err)
				}
			}
			if _, found, err := gates.Last(ctx, d.env.DB, tk.ID, reclaimedKind); err != nil || found {
				t.Fatalf("失败被记成回收成功：%v", err)
			}
			t.Logf("旧 Git 回收已开始 → 新状态 %s → 真 Git 拒绝伪造分支；状态和目录保留，loop_error 有原因", status)
		})
	}
}
