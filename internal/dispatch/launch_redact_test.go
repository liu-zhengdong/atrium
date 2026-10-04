package dispatch

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 本地拉起（startLocal）：执行者输出末尾不带换行时，尾行也要落进会话日志，且令牌落盘前脱敏。
// 真子进程跑一遍；wait 回收时用 defer 关 redact 与日志文件，顺序写反会把尾行写进已关闭的文件而丢掉。
func TestLocalLaunchLogKeepsUnterminatedTail(t *testing.T) {
	env, d := setup(t)
	ctx := context.Background()
	bin := filepath.Dir(must(exec.LookPath("kimi")))
	body := "#!/bin/sh\necho \"token=$ATRIUM_WORKER_TOKEN\"\nprintf 'tail-no-newline'\n"
	if err := os.WriteFile(filepath.Join(bin, "kimi"), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	tk, _ := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "尾巴"}, "u1")
	if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "kimi"}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := d.pump(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
	run, _ := workers.LastRun(ctx, env.DB, tk.ID)
	b, err := os.ReadFile(run.Log)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if !strings.Contains(s, "tail-no-newline") {
		t.Fatalf("末尾不带换行的尾行没落盘：%q", s)
	}
	if tok := workerToken("test-user-token", tk.ID, 1); strings.Contains(s, tok) {
		t.Fatalf("令牌落成明文：%q", s)
	}
	if !strings.Contains(s, "token="+platform.Redacted) {
		t.Fatalf("令牌该换成占位：%q", s)
	}
}
