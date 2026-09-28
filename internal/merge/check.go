package merge

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/watch"
)

// CheckScript 是目标仓库的快检查；没有就跳过并记一笔。
const CheckScript = ".agents/check"

// checkOutcome 是一次快检查的结果。
type checkOutcome struct {
	Skipped bool
	Pass    bool
	Stalled bool   // 两次都被 watch 以「10 分钟没输出」结束
	Tail    string // 输出末尾（没过时交回执行者）
	Log     string
}

// tailWriter 写日志文件（watch 看它有没有新输出），同时留末尾 8KB。
type tailWriter struct {
	mu  sync.Mutex
	f   *os.File
	buf []byte
}

func (w *tailWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf = append(w.buf, p...)
	if len(w.buf) > 8192 {
		w.buf = w.buf[len(w.buf)-8192:]
	}
	return w.f.Write(p)
}

// Tail 取文字最后 n 行。
func Tail(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

var failure = regexp.MustCompile(`(?m)^\s*(--- FAIL|FAIL\b|not ok\b)|\b[1-9]\d* (failed|failing)\b|✗|✖`)

// HasFailures 判检查输出里有没有失败用例（go test、node test、TAP、mocha 风格）。纯函数。
func HasFailures(out string) bool { return failure.MatchString(out) }

// runCheck 在 dir 跑快检查。进程登记给 watch（Role check）；watch 在 10 分钟没输出时结束它并记一笔 watch 经历，
// 这里再判：输出里有失败用例按没过交回；没有按「没跑成」重跑一次，再被结束按没过交回。
func runCheck(ctx context.Context, db *store.DB, dir, logDir, task string) (checkOutcome, error) {
	script := filepath.Join(dir, filepath.FromSlash(CheckScript))
	if _, err := os.Stat(script); errors.Is(err, os.ErrNotExist) {
		return checkOutcome{Skipped: true, Pass: true}, nil
	}
	for attempt := 0; ; attempt++ {
		out, killed, err := runOnce(ctx, db, script, dir, logDir, task)
		if err != nil || out.Pass || !killed || HasFailures(out.Tail) {
			return out, err
		}
		if attempt > 0 {
			out.Stalled = true
			return out, nil
		}
	}
}

func runOnce(ctx context.Context, db *store.DB, script, dir, logDir, task string) (out checkOutcome, killed bool, err error) {
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		return out, false, err
	}
	out.Log = filepath.Join(logDir, fmt.Sprintf("%s-%d.log", task, time.Now().UnixMilli()))
	f, err := os.OpenFile(out.Log, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return out, false, err
	}
	defer f.Close()
	w := &tailWriter{f: f}
	// 快检查跑的是仓库里的代码：用执行者白名单环境（不带凭据与 ATRIUM_*），不碰用户的服务。
	env := platform.WorkerEnv(runtime.GOOS, platform.EnvMap(os.Environ()))
	cmd, err := platform.Start(platform.Spec{Path: script, Dir: dir, Env: env, Stdout: w, Stderr: w, Detached: true})
	if err != nil {
		return out, false, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	if err := watch.Track(ctx, db, task, watch.Proc{Role: string(watch.RoleCheck), PID: cmd.Process.Pid, Log: out.Log, Dir: dir}); err != nil {
		platform.KillTree(cmd.Process.Pid)
		<-done
		return out, false, err
	}
	select {
	case werr := <-done:
		out.Pass = werr == nil
	case <-ctx.Done():
		platform.KillTree(cmd.Process.Pid)
		<-done
		return out, false, ctx.Err()
	}
	w.mu.Lock()
	out.Tail = Tail(string(w.buf), 40)
	w.mu.Unlock()
	if out.Pass {
		return out, false, nil
	}
	killed, err = killedByWatch(ctx, db, task)
	return out, killed, err
}

// killedByWatch：最近一次登记检查进程之后，watch 有没有记过「结束」。
func killedByWatch(ctx context.Context, q store.Querier, task string) (bool, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT count(*) FROM task_events WHERE task = ? AND kind = 'watch'
		AND id > (SELECT COALESCE(max(id), 0) FROM task_events WHERE task = ? AND kind = 'proc')`, task, task).Scan(&n)
	return n > 0, err
}
