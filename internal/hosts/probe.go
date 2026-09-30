package hosts

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 自检：机器上线时和之后每 ProbeEvery 对 workers 工具目录中装了的命令跑 --version，
// 用执行者同一份白名单环境。拉不起来、非 0 退出、超时就把「工具@机器」标成不可用（workers.MarkProbe），跑通了自动解除。
// 没装或自检失败的工具不列入主机可用工具。

// ProbeEvery 是自检间隔：装坏或修好后至多 10 分钟挑人就跟上，
// 期间真派过去起不来的由退出信号（workers.MarkOf）当场标记，自检只补「一直没人派、坏着没人发现」的那部分。
const ProbeEvery = 10 * time.Minute

// probeTimeout 是一次 --version 最多等多久：正常的都在 1 秒内，Windows 冷启动留足余量。
var probeTimeout = 20 * time.Second

// 测试关闭后台探测，免得跑到本机真装的工具。
var probeEnabled = true

// ProbeResult 是一次 --version 的原始结果。
type ProbeResult struct {
	Err      string // 拉不起来（exec 失败）的原因
	Code     int
	TimedOut bool
	Output   string // 标准输出与错误合在一起
}

// ProbeFailure 是自检不过的一个工具（代理报给服务）。
type ProbeFailure struct {
	Tool   string `json:"tool"`
	Reason string `json:"reason"`
	Output string `json:"output,omitempty"` // 输出的前几行
}

// probeLines 是记下的输出行数。
const probeLines = 3

// ProbeFault 判一次自检（纯函数）：跑通返回空；否则返回原因与输出的前几行（非空行，「；」连起来）。
func ProbeFault(exe string, r ProbeResult) (reason, lines string) {
	var keep []string
	for _, l := range strings.Split(r.Output, "\n") {
		if l = strings.TrimSpace(l); l != "" && len(keep) < probeLines {
			keep = append(keep, l)
		}
	}
	lines = clip(strings.Join(keep, "；"), 300)
	switch {
	case r.Err != "":
		return fmt.Sprintf("自检 %s --version 拉不起来：%s", exe, clip(r.Err, 200)), lines
	case r.TimedOut:
		return fmt.Sprintf("自检 %s --version %d 秒没结束", exe, int(probeTimeout/time.Second)), lines
	case r.Code != 0:
		return fmt.Sprintf("自检 %s --version 退出码 %d", exe, r.Code), lines
	}
	return "", lines
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// Probe 按给定环境（执行者的白名单环境）自检目录中的工具，返回成功工具与失败证据。
func Probe(ctx context.Context, env map[string]string, tools []workers.Tool) ProbeReport {
	var mu sync.Mutex
	var wg sync.WaitGroup
	out := ProbeReport{CLIs: map[string]CLI{}, Failed: []ProbeFailure{}}
	if !probeEnabled {
		return out
	}
	for _, t := range tools {
		path, err := platform.LookPath(t.Exe, env)
		if err != nil {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if reason, lines := ProbeFault(t.Exe, runVersion(ctx, path, env)); reason != "" {
				mu.Lock()
				out.Failed = append(out.Failed, ProbeFailure{Tool: t.Name, Reason: reason, Output: lines})
				mu.Unlock()
			} else {
				mu.Lock()
				c := CLI{Installed: true, Version: lines}
				home := env[platform.EnvKey(runtime.GOOS, "HOME")]
				if runtime.GOOS == "windows" {
					home = env["USERPROFILE"]
				}
				if home != "" {
					c.LoggedIn = LoggedIn(t.Name, runtime.GOOS, func(rel string) bool {
						_, err := os.Stat(filepath.Join(home, filepath.FromSlash(rel)))
						return err == nil
					})
				}
				out.CLIs[t.Name] = c
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return out
}

// limitBuf 只留前 n 字节（--version 的输出只看前几行）。
type limitBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
	n  int
}

func (w *limitBuf) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if room := w.n - w.b.Len(); room > 0 {
		w.b.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

// runVersion 跑一次 <path> --version，至多 probeTimeout；超时结束整棵进程树。
func runVersion(ctx context.Context, path string, env map[string]string) ProbeResult {
	out := &limitBuf{n: 16 * 1024}
	cmd, err := platform.Start(platform.Spec{Path: path, Args: []string{"--version"}, Env: env, Stdout: out, Stderr: out, Detached: true})
	if err != nil {
		return ProbeResult{Err: err.Error()}
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	r := ProbeResult{}
	select {
	case err = <-done:
	case <-time.After(probeTimeout):
		r.TimedOut = true
	case <-ctx.Done():
		r.TimedOut = true
	}
	if r.TimedOut {
		platform.KillTree(cmd.Process.Pid)
		err = <-done
	}
	var exit *exec.ExitError
	switch {
	case errors.As(err, &exit):
		r.Code = exit.ExitCode()
	case err != nil && !r.TimedOut:
		r.Err = err.Error()
	}
	out.mu.Lock()
	r.Output = out.b.String()
	out.mu.Unlock()
	return r
}

// probeMarks 把自检不过的翻成这台的标记（纯函数）；不认识的工具名丢掉（代理报的，只收 workers 工具目录里的）。
func probeMarks(failed []ProbeFailure, tools []workers.Tool) []workers.Mark {
	out := []workers.Mark{}
	for _, f := range failed {
		for _, t := range tools {
			if t.Name == f.Tool {
				out = append(out, workers.Mark{Tool: f.Tool, Kind: workers.MarkProbe, Reason: clip(f.Reason, 300), Evidence: clip(f.Output, 300)})
			}
		}
	}
	return out
}

// probeLocal 是本机（h1）的自检循环：每 5 秒检查目录变化，变化或到 ProbeEvery 就实测。
func probeLocal(ctx context.Context, env *app.Env) {
	wenv := platform.WorkerEnv(runtime.GOOS, platform.EnvMap(os.Environ()))
	var previous []workers.Tool
	var due time.Time
	for {
		tools, err := workers.ToolCatalog(ctx, env.DB)
		if err != nil {
			env.Log.Warn("读取工具目录失败", "err", err)
			return
		}
		if time.Now().Before(due) && slices.Equal(previous, tools) {
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
			}
			continue
		}
		report := Probe(ctx, wenv, tools)
		previous, due = tools, time.Now().Add(ProbeEvery)
		if ctx.Err() != nil {
			return
		}
		if err := recordProbe(ctx, env.DB, Local, report, tools); err != nil && ctx.Err() == nil {
			env.Log.Warn("记本机自检结果失败", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

// ProbeReport 同一轮上报成功工具与失败证据，未探测或没装的工具不在 CLIs 中。
type ProbeReport struct {
	CLIs   map[string]CLI `json:"clis"`
	Failed []ProbeFailure `json:"failed"`
}

func recordProbe(ctx context.Context, db *store.DB, host string, report ProbeReport, tools []workers.Tool) error {
	h, err := Get(ctx, db, host)
	if err != nil {
		return err
	}
	if h.Info == nil {
		h.Info = &Info{}
	}
	h.Info.CLIs = map[string]CLI{}
	for _, tool := range tools {
		if c, ok := report.CLIs[tool.Name]; ok {
			h.Info.CLIs[tool.Name] = c
		}
	}
	if err := workers.SyncProbes(ctx, db, host, probeMarks(report.Failed, tools), store.Now()); err != nil {
		return err
	}
	return touch(ctx, db, host, h.Info, nil)
}
