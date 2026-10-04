package leaders

import (
	"context"
	"errors"
	"fmt"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/worktree"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// launch 签发令牌、组提示词、经 Launcher 与 platform 拉起，等到退出或超时；令牌在返回时作废。
func (h *hub) launch(ctx context.Context, env *app.Env, p Pending, attempt *Attempt) (wakeRun, error) {
	var run wakeRun
	who, err := org.GetIdentity(ctx, env.DB, p.Leader)
	if err != nil {
		return run, err
	}
	h.mu.Lock()
	fails := h.fails[p.Leader]
	h.mu.Unlock()
	run.n = fails + 1
	if len(who.Workers) == 0 {
		return run, fmt.Errorf("%s 没有登记执行者组合", who.ID)
	}
	run.profile = who.Workers[0]
	attempt.Profile, attempt.Finish = "", nil
	attempt.Preferred = who.Workers
	l := getLauncher()
	if l == nil {
		return run, errors.New("拉起接口还没接上（leaders.SetLauncher）")
	}
	prompt, err := buildPrompt(ctx, env.DB, who, p.IDs)
	if err != nil {
		return run, err
	}
	dir := filepath.Join(env.Paths.Data, "leaders", who.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return run, err
	}
	// 会话临时目录：同一负责人同时只有一次唤醒，每次先清空；退出后按它回收残留进程。
	tmp := filepath.Join(dir, "tmp")
	if err := worktree.RemoveTemp(tmp); err != nil {
		return run, err
	}
	if err := os.MkdirAll(tmp, 0o700); err != nil {
		return run, err
	}
	token, err := h.issue(who.ID)
	if err != nil {
		return run, err
	}
	defer h.revoke(token)
	spec, err := l(ctx, Launch{Leader: who.ID, Profile: run.profile, Prompt: prompt, Dir: dir,
		Attempt: attempt, Env: leaderEnv(platform.EnvMap(os.Environ()), token, env.Paths.Data, tmp)})
	if attempt != nil && attempt.Profile != "" {
		run.profile = attempt.Profile
	}
	if err != nil {
		return run, err
	}
	run.log = filepath.Join(dir, "wake.log")
	logf, err := platform.OpenLog(run.log)
	if err != nil {
		return run, err
	}
	defer logf.Close()
	fmt.Fprintf(logf, "\n=== %s 唤醒 %s（%s），事件 %v\n", time.Now().Format(time.RFC3339), who.ID, run.profile, p.IDs)
	if run.from, err = logf.Seek(0, io.SeekCurrent); err != nil {
		return run, err
	}
	spec.ManagedTree = true
	redact := platform.RedactLog(logf, spec.Env)
	spec.Stdout, spec.Stderr, spec.Detached = redact, redact, true
	if spec.Dir == "" {
		spec.Dir = dir
	}
	run.begin = store.Now()
	cmd, err := platform.Start(spec)
	if err != nil {
		return run, err
	}
	run.started = true
	err = waitLimited(ctx, cmd, tmp, h.timeout)
	redact.Close()
	run.end = store.Now()
	return run, err
}

// waitLimited 等进程退出并回收会话残留；超时或服务停下就结束整棵进程树。
func waitLimited(ctx context.Context, cmd *exec.Cmd, tmp string, limit time.Duration) error {
	done := make(chan error, 1)
	go func() { done <- platform.WaitSession(cmd, tmp) }()
	timer := time.NewTimer(limit)
	defer timer.Stop()
	select {
	case err := <-done:
		return err
	case <-timer.C:
		platform.KillTree(cmd.Process.Pid)
		<-done
		return fmt.Errorf("超过 %s 没结束，已结束", limit)
	case <-ctx.Done():
		platform.KillTree(cmd.Process.Pid)
		<-done
		return ctx.Err()
	}
}

// leaderEnv：执行者白名单环境（临时目录是这位负责人的会话临时目录），去掉 ATRIUM_WORKER（负责人不是执行者），加本次令牌与数据目录；
// 服务所在目录排进 PATH 最前，atrium 命令就是这个服务的同一个二进制。
func leaderEnv(base map[string]string, token, data, tmp string) map[string]string {
	env := platform.WorkerEnv(runtime.GOOS, base, tmp)
	delete(env, "ATRIUM_WORKER")
	env["ATRIUM_LEADER_TOKEN"] = token
	env["ATRIUM_DATA"] = data
	platform.SelfOnPath(env)
	return env
}

func buildPrompt(ctx context.Context, q store.Querier, who org.Identity, ids []int64) (string, error) {
	in := PromptInput{Leader: who}
	roster, err := org.Leaders(ctx, q)
	if err != nil {
		return "", err
	}
	in.Names = make(map[string]string, len(roster))
	for _, identity := range roster {
		in.Names[identity.ID] = identity.Name
	}
	ps, err := org.Parents(ctx, q)
	if err != nil {
		return "", err
	}
	if in.Global, err = org.Principles(); err != nil {
		return "", err
	}
	skills, err := org.Skills(ctx, q)
	if err != nil {
		return "", err
	}
	in.Skills = org.SkillIndex(skills, "")
	lm, err := org.LeaderMap(ctx, q)
	if err != nil {
		return "", err
	}
	for _, d := range who.Depts {
		dept, err := org.Get(ctx, q, d)
		if err != nil {
			return "", err
		}
		b := DeptBrief{Dept: dept}
		if b.Path, err = org.Ancestors(ctx, q, d); err != nil {
			return "", err
		}
		if b.Chain, err = org.Chain(ctx, q, d); err != nil {
			return "", err
		}
		if b.Materials, err = MaterialsOverview(ctx, q, d); err != nil {
			return "", err
		}
		for _, c := range org.Covered(ps, lm, d) {
			sub, err := org.Get(ctx, q, c)
			if err != nil {
				return "", err
			}
			b.Covered = append(b.Covered, sub)
		}
		in.Depts = append(in.Depts, b)
	}
	memo, err := org.GetMemo(ctx, q, who.ID)
	if err != nil {
		return "", err
	}
	in.Memo = memo.Body
	if in.Events, err = eventRows(ctx, q, ids); err != nil {
		return "", err
	}
	in.Upstream = Upstream(ps, lm, who.ID, "")
	return Prompt(in), nil
}
