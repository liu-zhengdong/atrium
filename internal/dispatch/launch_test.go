package dispatch

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
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
	if runtime.GOOS != "windows" {
		t.Skip("验证 Windows .cmd 参数边界")
	}
	for _, tc := range []struct {
		name, config string
		remote       bool
	}{
		{"换行参数", "args: [\"bad\\nargument\"]\n", false},
		{"空字符参数", "args: [\"bad\\0argument\"]\n", false},
		{"空字符环境", "env: {DEMO: \"bad\\0value\"}\n", false},
		{"远程拉起失败", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("HOME", dir)
			t.Setenv("USERPROFILE", dir)
			bin := filepath.Join(dir, "bin")
			if err := os.MkdirAll(bin, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(bin, "fake.cmd"), []byte("@echo off\r\necho done\r\n"), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			db, err := store.Open(filepath.Join(dir, "data", "atrium.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			env := &app.Env{DB: db, Paths: config.Paths{Data: filepath.Join(dir, "data")}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Pause: &pause.Store{DB: db}}
			if err := os.WriteFile(env.Paths.Token(), []byte("test-token"), 0600); err != nil {
				t.Fatal(err)
			}
			oldPick, oldSpares, oldLaunch := pickHost, spares, launchRemote
			defer func() { pickHost, spares, launchRemote = oldPick, oldSpares, oldLaunch }()
			pickHost = func(_ context.Context, _ *app.Env, _ HostNeed, host string) (HostChoice, error) {
				if host == "" {
					host = LocalHost
				}
				return HostChoice{Kind: "run", Host: host}, nil
			}
			spares = func(context.Context, *app.Env) (map[string]Spare, error) { return map[string]Spare{}, nil }
			launchRemote = func(context.Context, *app.Env, string, Remote) (int, int, string, error) {
				return 0, 0, "", errors.New("非法远程启动参数")
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			ids := []string{}
			for i, name := range []string{"bad", "good"} {
				source := "---\nprotocol: cli\ncommand: fake\ndone_match: done\n"
				if i == 0 {
					source += tc.config
				}
				source += "---\n"
				if _, err := workers.SaveProfile(ctx, db, "harness/"+name, workers.Edit{Source: &source}, "u1"); err != nil {
					t.Fatal(err)
				}
				task, err := ledger.Add(ctx, db, ledger.NewTask{Title: name}, "u1")
				if err != nil {
					t.Fatal(err)
				}
				opts := Options{Worker: name}
				if i == 0 && tc.remote {
					opts.Host = "h9"
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
			waitFor(t, env, ids[0], func(x ledger.Task) bool { return x.Status == ledger.Blocked })
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
