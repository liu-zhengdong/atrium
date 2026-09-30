package dispatch

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 临时数据库、临时 PATH 和假工具：真实自检落库后，现有派活循环自动接着派。
func TestStartupProbeAutoDispatch(t *testing.T) {
	for _, installed := range []bool{true, false} {
		name := "就绪后自动派出"
		if !installed {
			name = "确实没装仍受阻"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("HOME", dir)
			t.Setenv("USERPROFILE", dir)
			bin := filepath.Join(dir, "bin")
			if err := os.MkdirAll(bin, 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin)
			if installed {
				file, body := "startupfake", "#!/bin/sh\necho startup-fake-done\n"
				if runtime.GOOS == "windows" {
					file, body = "startupfake.cmd", "@echo off\r\necho startup-fake-done\r\n"
				}
				if err := os.WriteFile(filepath.Join(bin, file), []byte(body), 0700); err != nil {
					t.Fatal(err)
				}
			}
			db, err := store.Open(filepath.Join(dir, "db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			env := &app.Env{DB: db, Paths: config.Paths{Data: dir}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Pause: &pause.Store{DB: db}}
			if err := os.WriteFile(env.Paths.Token(), []byte("test-token"), 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cancel()
			source := "---\nprotocol: cli\ncommand: startupfake\ndone_match: startup-fake-done\n---\n"
			if _, err := workers.SaveProfile(ctx, db, "harness/startupfake", workers.Edit{Source: &source}, "u1"); err != nil {
				t.Fatal(err)
			}
			// 先有旧登记，再走服务启动时的刷新；不能沿用过期的可用事实。
			if err := hosts.EnsureLocal(ctx, db, hosts.Info{CLIs: map[string]hosts.CLI{"startupfake": {Installed: true}}}); err != nil {
				t.Fatal(err)
			}
			if err := hosts.EnsureLocal(ctx, db, hosts.LocalInfo(dir)); err != nil {
				t.Fatal(err)
			}
			oldSpares := spares
			spares = func(context.Context, *app.Env) (map[string]Spare, error) { return map[string]Spare{}, nil }
			defer func() { spares = oldSpares }()
			tk, err := ledger.Add(ctx, db, ledger.NewTask{Title: name}, "u1")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Enqueue(ctx, env, tk.ID, Options{}, "u1"); err != nil {
				t.Fatal(err)
			}
			d := get(env)
			if err := d.pump(ctx); err != nil {
				t.Fatal(err)
			}
			got, err := ledger.Get(ctx, db, tk.ID)
			if err != nil || got.Status != ledger.Queued {
				t.Fatalf("自检前应等待：%+v %v", got, err)
			}
			v, err := d.view(ctx, got, "low", nil)
			if err != nil || !v.Waiting || !strings.Contains(v.Reason, "尚未完成工具自检") {
				t.Fatalf("%+v %v", v, err)
			}
			// 不再入队、不手动 wake，真实后台自检和派活循环自行推进。
			done, hostDone := make(chan error, 1), make(chan error, 1)
			go func() { done <- Run(ctx, env) }()
			go func() { hostDone <- hosts.Run(ctx, env) }()
			defer func() {
				cancel()
				if err := <-done; err != nil {
					t.Error(err)
				}
				if err := <-hostDone; err != nil {
					t.Error(err)
				}
				d.wg.Wait()
			}()
			want := ledger.Blocked
			for {
				got, err = ledger.Get(ctx, db, tk.ID)
				if err != nil {
					t.Fatal(err)
				}
				if installed && got.Status == ledger.Blocked {
					t.Fatalf("自检窗口导致受阻：%+v", got)
				}
				if installed && got.Stage == ledger.StageGate || !installed && got.Status == want {
					break
				}
				select {
				case <-ctx.Done():
					t.Fatalf("等待自检后派活超时：%+v", got)
				case <-time.After(20 * time.Millisecond):
				}
			}
			var blocked int
			if err := db.QueryRow(`SELECT count(*) FROM task_events WHERE task=? AND kind='block'`, tk.ID).Scan(&blocked); err != nil {
				t.Fatal(err)
			}
			if installed && blocked != 0 {
				t.Fatalf("出现过 blocked：%d", blocked)
			}
			if !installed && blocked != 1 {
				t.Fatalf("确实没装应受阻一次：%d", blocked)
			}
			t.Logf("自检前 queued；自检后 status=%s stage=%s，blocked 记录=%d", got.Status, got.Stage, blocked)
		})
	}
}
