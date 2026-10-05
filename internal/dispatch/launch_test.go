package dispatch

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 用真实分派任务循环与假执行者验证：非法启动输入只影响本任务，下一件仍能执行。
func TestLaunchFailureKeepsDispatchRunning(t *testing.T) {
	nonIsolated(t)
	for _, tc := range []struct {
		name, model string
		remote      bool
	}{
		{"坏档案", "novendor", false},
		{"远程拉起失败", "fake/ok", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("HOME", dir)
			t.Setenv("USERPROFILE", dir)
			fakeDshOnPath(t)
			db, err := store.Open(filepath.Join(dir, "data", "atrium.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			env := &app.Env{DB: db, Paths: config.Paths{Data: filepath.Join(dir, "data")}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Pause: &pause.Store{DB: db}}
			if err := os.WriteFile(env.Paths.Token(), []byte("test-token"), 0600); err != nil {
				t.Fatal(err)
			}
			oldPick, oldLaunch := pickHost, launchRemote
			defer func() { pickHost, launchRemote = oldPick, oldLaunch }()
			pickHost = func(_ context.Context, _ *app.Env, _ HostNeed, host string) (HostChoice, error) {
				if host == "" {
					host = LocalHost
				}
				return HostChoice{Kind: "run", Host: host}, nil
			}
			launchRemote = func(context.Context, *app.Env, string, Remote) (int, int, string, error) {
				return 0, 0, "", errors.New("非法远程启动参数")
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			// 坏档案：模型里没有 provider/模型，dsh 的自检过不去；好档案带完整模型。
			bad := "dsh+bad-c"
			source := "---\nmodel: " + tc.model + "\n---\n"
			if _, err := workers.SaveProfile(ctx, db, "combos/"+bad, workers.Edit{Source: &source}, "u1"); err != nil {
				t.Fatal(err)
			}
			good := fakeCombo(t, ctx, db, "ok", "")
			ids := []string{}
			for i, name := range []string{bad, good} {
				task, err := ledger.Add(ctx, db, ledger.NewTask{Title: name}, "u1")
				if err != nil {
					t.Fatal(err)
				}
				opts := Options{Worker: name}
				if i == 0 && tc.remote {
					opts.Host = "h9"
				}
				if i == 0 && !tc.remote {
					// 坏档案在入队时就过不去 Resolved.Check，报错即「受阻」，不实际拉起。
					if _, err := Enqueue(ctx, env, task.ID, opts, "u1"); err == nil {
						t.Fatal("坏档案入队应报错")
					}
					ids = append(ids, task.ID)
					continue
				}
				if _, err := Enqueue(ctx, env, task.ID, opts, "u1"); err != nil {
					t.Fatal(err)
				}
				ids = append(ids, task.ID)
			}
			done := make(chan error, 1)
			go func() { done <- Run(ctx, env) }()
			defer func() {
				cancel()
				if err := <-done; err != nil {
					t.Errorf("分派任务循环退出：%v", err)
				}
				get(env).wg.Wait()
			}()
			if tc.remote {
				waitFor(t, env, ids[0], func(x ledger.Task) bool { return x.Status == ledger.Blocked })
			}
			waitFor(t, env, ids[1], func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
			select {
			case err := <-done:
				done <- err
				t.Fatalf("任务错误使循环退出：%v", err)
			default:
			}
			t.Log("非法输入任务受阻，后续任务进入交付检查，分派任务循环仍运行")
		})
	}
}
