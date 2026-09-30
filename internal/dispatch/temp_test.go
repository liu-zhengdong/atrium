package dispatch

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 隔离 SQLite 与实际假执行者进程，临时文件由子进程按 TMPDIR 写入。
func TestTaskTempLifecycle(t *testing.T) {
	for _, location := range []string{"repo", "work", "dir"} {
		for _, ending := range []ledger.Status{ledger.Cancelled, ledger.Done} {
			t.Run(location+"/"+string(ending), func(t *testing.T) {
				d, gh, ctx := reclaimRig(t)
				input := ledger.NewTask{Title: "临时目录回收"}
				if location == "repo" {
					input.Repo = gh.Work
				} else if location == "dir" {
					input.Dir = t.TempDir()
				}
				tk, err := ledger.Add(ctx, d.env.DB, input, "u1")
				if err != nil {
					t.Fatal(err)
				}
				exe, err := os.Executable()
				if err != nil {
					t.Fatal(err)
				}
				t.Setenv("PATH", filepath.Dir(exe)+string(os.PathListSeparator)+os.Getenv("PATH"))
				quoted, _ := json.Marshal(filepath.Base(exe))
				mode := "--reclaim-fake-worker"
				if ending == ledger.Cancelled {
					mode = "--reclaim-wait-worker"
				}
				source := "---\nprotocol: cli\ncommand: " + string(quoted) + "\nargs: [\"" + mode + "\", \"{prompt}\"]\ndone_match: '^DONE$'\n---\n"
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
				stop := runReclaimLoop(t, d, ctx)
				waitReclaim(t, ctx, func() bool {
					got, err := ledger.Get(ctx, d.env.DB, tk.ID)
					if ending == ledger.Cancelled {
						_, fileErr := os.Stat(filepath.Join(TaskDir(d.env.Paths.Data, tk.ID), "tmp", "readonly"))
						return err == nil && got.Status == ledger.Running && fileErr == nil
					}
					return err == nil && got.Stage == ledger.StageGate
				})
				temp := filepath.Join(TaskDir(d.env.Paths.Data, tk.ID), "tmp")
				if b, err := os.ReadFile(filepath.Join(temp, "readonly")); err != nil || string(b) != "只读缓存" {
					t.Fatalf("执行者没写临时文件：%s %v", b, err)
				}
				applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Set, To: ending})
				waitReclaim(t, ctx, func() bool {
					_, found, err := gates.Last(ctx, d.env.DB, tk.ID, reclaimedKind)
					return err == nil && found
				})
				stop()
				if _, err := os.Stat(temp); !os.IsNotExist(err) {
					t.Fatalf("临时目录仍在：%v", err)
				}
				if location != "repo" {
					work := input.Dir
					if work == "" {
						work = filepath.Join(TaskDir(d.env.Paths.Data, tk.ID), "work")
					}
					if _, err := os.Stat(filepath.Join(work, "continued.txt")); err != nil {
						t.Fatalf("工作内容被删除：%v", err)
					}
				}
				t.Log("执行者 TMPDIR/TMP/TEMP 一致，只读文件已写入；终态 tmp 已删除")
			})
		}
	}
}
