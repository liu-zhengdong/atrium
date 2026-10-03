package dispatch

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 子进程也是测试二进制，只运行这个假执行者，不调用任何模型或本机登录。
func TestLoopWorkerHelper(t *testing.T) { fmt.Println("loop-fake-done") }

func TestLoopBadRecordsStillDispatches(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
	db, err := store.Open(filepath.Join(dir, "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Pause: &pause.Store{DB: db}}
	if err := os.WriteFile(env.Paths.Token(), []byte("test-token"), 0600); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0700); err != nil {
		t.Fatal(err)
	}
	name := "loopfake"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	content, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, name), content, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	source := "---\nprotocol: cli\ncommand: loopfake\nargs: ['-test.run=^TestLoopWorkerHelper$']\ndone_match: loop-fake-done\n---\n"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := workers.SaveProfile(ctx, db, "harness/loopfake", workers.Edit{Source: &source}, "u1"); err != nil {
		t.Fatal(err)
	}
	oldPick := pickHost
	defer func() { pickHost = oldPick }()
	pickHost = func(context.Context, *app.Env, HostNeed, string) (HostChoice, error) {
		return HostChoice{Kind: "run", Host: LocalHost}, nil
	}
	var ids []string
	for _, name := range []string{"bad launch record", "bad queue opts", "good"} {
		task, err := ledger.Add(ctx, db, ledger.NewTask{Title: name}, "u1")
		if err != nil {
			t.Fatal(err)
		}
		opts := Options{Worker: "loopfake"}
		if name == "good" {
			opts.Worker = ""
		} // 自动挑人也不能被别件的坏统计挡住
		if _, err := Enqueue(ctx, env, task.ID, opts, "u1"); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, task.ID)
	}
	if _, err := ledger.Apply(ctx, db, ids[0], ledger.Event{Kind: ledger.Start}, "runtime", "test"); err != nil {
		t.Fatal(err)
	}
	if err := ledger.Record(ctx, db, ids[0], workers.RunKind, "runtime", `{broken`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE queue SET opts='{broken' WHERE task=?`, ids[1]); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- Run(ctx, env) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("loop exit: %v", err)
		}
		get(env).wg.Wait()
	}()
	for _, id := range ids[:2] {
		waitFor(t, env, id, func(task ledger.Task) bool { return task.Status == ledger.Blocked })
	}
	waitFor(t, env, ids[2], func(task ledger.Task) bool { return task.Stage == ledger.StageGate })
	select {
	case err := <-done:
		done <- err
		t.Fatalf("循环因单件错误退出：%v", err)
	default:
	}
	if err := get(env).pump(ctx); err != nil {
		t.Fatal(err)
	}
	for _, id := range ids[:2] {
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM task_events WHERE task=? AND kind=?`, id, ledger.KindLoopError).Scan(&n); err != nil {
			t.Fatal(err)
		}
		want := 1
		if id == ids[0] {
			want = 2
		} // 继续跟进与共享统计各留一次有归属的错误
		if n != want {
			t.Fatalf("%s 记录了 %d 次错误", id, n)
		}
	}
	t.Log("坏拉起登记、坏队列 JSON 各自受阻；正常假执行者进入交付检查，循环仍运行")
}
