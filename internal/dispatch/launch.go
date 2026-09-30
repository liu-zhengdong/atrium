package dispatch

import (
	"context"
	"fmt"
	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// launch 拉起一次执行者：备好工作目录与提示词、算出进程调用、白名单环境加凭据、落账、跟着等它退出。
func (d *dispatcher) launch(ctx context.Context, t ledger.Task, o launchOpts) error {
	db, data := d.env.DB, d.env.Paths.Data
	remote := o.Host != LocalHost
	var dir, branch string
	var err error
	if !remote {
		if dir, branch, err = Workdir(ctx, data, t.ID, t.Repo, t.Dir); err != nil {
			if isAPI(err) {
				return err
			}
			return api.Conflict("准备工作目录失败：%v", err)
		}
	} else if t.Repo != "" {
		branch = Branch(t.ID)
	}
	last, err := workers.LastRun(ctx, db, t.ID)
	if err != nil {
		return err
	}
	n := 1
	if last != nil {
		n = last.N + 1
	}
	td := TaskDir(data, t.ID)
	if err := os.MkdirAll(td, 0o700); err != nil {
		return err
	}
	secrets := o.Secrets
	in := PromptInput{Task: t.ID, Org: t.Org, Title: t.Title, Profile: o.W.Body, Repo: t.Repo, Dir: t.Dir, Branch: branch}
	if in.Origin, err = gates.Origin(ctx, gates.NewExec(), t.Repo); err != nil {
		return err
	}
	if in.Global, err = org.Principles(); err != nil {
		return err
	}
	if t.Org != "" {
		chain, err := org.Chain(ctx, db, t.Org)
		if err != nil {
			return err
		}
		for _, p := range chain {
			in.Points = append(in.Points, org.ChainLine(p))
		}
		in.Points = append(in.Points, org.PointsOver(chain)...)
	}
	if t.Skill != "" {
		s, err := skillOf(ctx, d.env, t.Skill)
		if err != nil {
			return err
		}
		in.Skill, secrets = t.Skill, union(secrets, s.Secrets)
	}
	if in.Skills, err = skillIndex(ctx, d.env, t.Skill); err != nil {
		return err
	}
	var upto int64
	in.Detail, upto, err = ledger.Brief(ctx, db, t)
	if err != nil {
		return err
	}
	if in.Bounces, err = bounceNotes(ctx, db, t.ID); err != nil {
		return err
	}
	if in.Guide, err = repoGuide(data, t.Repo, dir); err != nil {
		return err
	}
	prompt := BuildPrompt(in)
	if o.Session != "" {
		prompt = ResumePrompt(o.Pending)
	}
	promptFile := filepath.Join(td, fmt.Sprintf("prompt-%d.md", n))
	if err := os.WriteFile(promptFile, []byte(prompt), 0o600); err != nil {
		return err
	}
	req := o.W.Request(prompt, promptFile, dir)
	req.Task, req.Session = t.ID, o.Session
	req.Live = o.W.Adapter.Tell == workers.TellStdin && o.Session == "" && !remote
	extra, err := secretEnv(ctx, d.env, t.Org, secrets)
	if err != nil {
		return err
	}
	if key := o.W.Rules.EndpointKey; key != "" {
		v, err := secretEnv(ctx, d.env, t.Org, []string{key})
		if err != nil {
			return err
		}
		extra[o.W.Endpoint().KeyEnv] = v[key]
	}
	token, err := issueWorkerToken(d.env, t.ID, n)
	if err != nil {
		return err
	}
	run := workers.Run{N: n, Why: o.Why, Cause: o.Cause, Worker: o.W.ID, Host: o.Host, Dir: dir, Branch: branch,
		Log: filepath.Join(td, fmt.Sprintf("run-%d.log", n)), Risk: o.Risk, Secrets: secrets, TellsUpto: upto, At: store.Now()}
	p := &proc{task: t.ID, adapter: o.W.Adapter, remote: remote, pending: map[string]bool{}, done: make(chan struct{})}
	var wait func() int
	if remote {
		clone := ""
		if t.Repo != "" {
			repo, err := RemoteRepo(ctx, t.Repo)
			if err != nil {
				return api.Conflict("%s 派不到远程：%v", t.ID, err)
			}
			if _, clone, err = RepoSource(data, repo); err != nil {
				return err
			}
		}
		rr, pid, rdir, err := launchRemote(ctx, d.env, o.Host, Remote{Task: t.ID, Tool: o.W.Spec.Tool, Request: req, Repo: clone,
			Branch: branch, Base: "main", Env: extra, Token: token, Log: run.Log})
		if err != nil {
			return fmt.Errorf("远程执行者拉起失败：%w", err)
		}
		run.PID, run.RemoteRun, run.Dir = pid, rr, rdir
		wait = d.remoteWaiter(p, rr)
	} else {
		cmdWait, pid, stdin, err := startLocal(o.W.Spec.Tool, req, extra, conn{fmt.Sprintf("http://127.0.0.1:%d", d.env.Port), token}, run.Log, prompt, n)
		if err != nil {
			return fmt.Errorf("本机执行者拉起失败：%w", err)
		}
		run.PID, p.stdin, wait = pid, stdin, cmdWait
	}
	p.run = run
	if err := d.record(ctx, t, run); err != nil {
		d.kill(context.WithoutCancel(ctx), p)
		wait()
		return err
	}
	d.track(p, wait)
	return nil
}

// conn 是执行者的命令行连回服务用的：服务地址与本次拉起的执行者令牌。
type conn struct{ server, token string }

// startLocal 在本机拉起：白名单环境（带 ATRIUM_WORKER=1）+ 工具要的变量 + 凭据 + 连回服务的地址与令牌；
// 服务所在目录排进 PATH 最前（atrium 就是服务这个二进制）；日志直接写文件（服务重启不影响执行者）。
func startLocal(tool string, req workers.Request, extra map[string]string, c conn, log, prompt string, n int) (wait func() int, pid int, stdin *os.File, err error) {
	l, err := workers.Build(tool, req)
	if err != nil {
		return nil, 0, nil, err
	}
	env := platform.WorkerEnv(runtime.GOOS, platform.EnvMap(os.Environ()))
	for k, v := range l.Env {
		env[k] = v
	}
	for k, v := range extra {
		if _, taken := env[k]; taken {
			return nil, 0, nil, api.Usage("凭据 %s 会盖掉执行者环境里已有的变量，换个名字", k)
		}
		env[k] = v
	}
	env["ATRIUM_TASK"] = req.Task
	env["ATRIUM_SERVER"], env["ATRIUM_WORKER_TOKEN"] = c.server, c.token
	platform.SelfOnPath(env)
	exe, err := platform.LookPath(l.Exe, env)
	if err != nil {
		return nil, 0, nil, api.Conflict("没装 %s：%v", l.Exe, err)
	}
	logf, err := platform.OpenLog(log)
	if err != nil {
		return nil, 0, nil, err
	}
	defer logf.Close()
	var in io.Reader
	switch {
	case l.Live:
		r, w, err := os.Pipe()
		if err != nil {
			return nil, 0, nil, err
		}
		defer r.Close()
		if _, err := w.Write(workers.UserLine(prompt, fmt.Sprintf("prompt-%d", n))); err != nil {
			w.Close()
			return nil, 0, nil, err
		}
		in, stdin = r, w
	case l.StdinData != "":
		in = strings.NewReader(l.StdinData)
	case l.StdinFile != "":
		f, err := os.Open(l.StdinFile)
		if err != nil {
			return nil, 0, nil, err
		}
		defer f.Close()
		in = f
	}
	spec := platform.Spec{Path: exe, Args: l.Args, Dir: l.Dir, Env: env, Stdout: logf, Stderr: logf, Detached: true}
	if in != nil {
		spec.Stdin = in
	}
	cmd, err := platform.Start(spec)
	if err != nil {
		if stdin != nil {
			stdin.Close()
		}
		return nil, 0, nil, err
	}
	return func() int {
		if err := cmd.Wait(); err != nil && cmd.ProcessState == nil {
			return workers.ExitUnknown
		}
		return cmd.ProcessState.ExitCode()
	}, cmd.Process.Pid, stdin, nil
}
