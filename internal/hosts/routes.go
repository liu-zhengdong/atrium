package hosts

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// View 是 host ls / show 的一台。
type View struct {
	Host
	Conn    Conn   `json:"conn"`
	Status  string `json:"status"`
	Paused  bool   `json:"paused"`
	Running int    `json:"running"`
	Max     int    `json:"max"`              // 同时最多跑几个：登记时给的优先，否则按核数；0 不限
	Tunnel  string `json:"tunnel,omitempty"` // 隧道状态（带 --ssh 的）
}

func views(ctx context.Context, env *app.Env, list []Host) ([]View, error) {
	busy, err := running(ctx, env.DB)
	if err != nil {
		return nil, err
	}
	pauses, err := env.Pause.List(ctx)
	if err != nil {
		return nil, err
	}
	var active []string
	for _, p := range pauses {
		active = append(active, p.Scope)
	}
	now := store.Now()
	out := []View{}
	for _, h := range list {
		paused := pause.Paused(active, pause.Scope{Host: h.ID})
		c := candidate(h, busy[h.ID], paused, theHub.isPolling(h.ID), now)
		v := View{Host: h, Conn: c.Conn, Paused: paused, Running: c.Running, Max: c.Max,
			Status: ConnText(c.Conn, paused, h.LastSeen, h.JoinExpires, now)}
		if h.SSH != "" {
			v.Tunnel = tunnelStatus(h.ID)
			v.TunnelLocal = tunnelLocal(h, env.Port)
		}
		out = append(out, v)
	}
	return out, nil
}

// AddResult 是 host add／edit 的回执：接入码只在这里出现一次（edit 不带 --join 时为空）。
type AddResult struct {
	Host    View   `json:"host"`
	Code    string `json:"code,omitempty"`
	Command string `json:"command,omitempty"` // 在远程机器上跑的那一行
}

// addResult 是 host add／edit 的回执；有接入码时附在那台上跑的命令（有隧道走隧道远端端口）。
func addResult(ctx context.Context, env *app.Env, h Host, code string) (AddResult, error) {
	vs, err := views(ctx, env, []Host{h})
	if err != nil {
		return AddResult{}, err
	}
	r := AddResult{Host: vs[0], Code: code}
	if code != "" {
		port := env.Port
		if h.TunnelRemote != 0 {
			port = h.TunnelRemote
		}
		r.Command = "atrium agent --server http://127.0.0.1:" + strconv.Itoa(port) + " --token " + code
	}
	return r, nil
}

func userOnly(q *api.Req) error {
	if q.Actor.Kind != "user" {
		return api.Forbidden("只有用户能登记或移除机器")
	}
	return nil
}

// pollWait 是长轮询每轮最多挂多久（测试调短）。
var pollWait = 25 * time.Second

var logMu sync.Mutex

func Routes(r *api.Router, env *app.Env) {
	if err := EnsureLocal(context.Background(), env.DB, LocalInfo(env.Paths.Data)); err != nil {
		env.Log.Error("登记本机失败", "err", err)
	}
	r.Handle("POST /api/hosts", func(q *api.Req) (any, error) {
		if err := userOnly(q); err != nil {
			return nil, err
		}
		var in AddInput
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		h, code, err := Add(q.Context(), env.DB, in, env.Port)
		if err != nil {
			return nil, err
		}
		return addResult(q.Context(), env, h, code)
	})
	r.Handle("GET /api/hosts", func(q *api.Req) (any, error) {
		list, err := List(q.Context(), env.DB)
		if err != nil {
			return nil, err
		}
		return views(q.Context(), env, list)
	})
	r.Handle("GET /api/hosts/{id}", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "h")
		if err != nil {
			return nil, err
		}
		h, err := Get(q.Context(), env.DB, id)
		if err != nil {
			return nil, err
		}
		vs, err := views(q.Context(), env, []Host{h})
		if err != nil {
			return nil, err
		}
		return vs[0], nil
	})
	r.Handle("PATCH /api/hosts/{id}", func(q *api.Req) (any, error) {
		if err := userOnly(q); err != nil {
			return nil, err
		}
		id, err := q.Ref("id", "h")
		if err != nil {
			return nil, err
		}
		var in EditInput
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		h, code, err := Edit(q.Context(), env.DB, id, in, env.Port)
		if err != nil {
			return nil, err
		}
		return addResult(q.Context(), env, h, code)
	})
	r.Handle("DELETE /api/hosts/{id}", func(q *api.Req) (any, error) {
		if err := userOnly(q); err != nil {
			return nil, err
		}
		id, err := q.Ref("id", "h")
		if err != nil {
			return nil, err
		}
		return map[string]string{"id": id}, Remove(q.Context(), env.DB, id)
	})
	agentRoutes(r, env)
}

// 代理的接口用 Public 注册、在这里自己认机器令牌：机器令牌只在 /api/agent/* 有效，
// 不进全局认证（否则拿着机器令牌也能调用户的接口）。
func agentRoutes(r *api.Router, env *app.Env) {
	auth := func(q *api.Req) (string, error) {
		tok, _ := strings.CutPrefix(q.Header.Get("Authorization"), "Bearer ")
		if id, ok := Verify(q.Context(), env.DB, tok); ok {
			return id, nil
		}
		return "", &api.Error{Status: 401, Code: "unauthorized", Message: "机器令牌无效或这台已移除；在服务那台重新 atrium host add 后再接入"}
	}
	handle := func(pattern string, fn func(q *api.Req, host string) (any, error)) {
		r.Public(pattern, func(q *api.Req) (any, error) {
			host, err := auth(q)
			if err != nil {
				return nil, err
			}
			return fn(q, host)
		})
	}
	r.Public("POST /api/agent/join", func(q *api.Req) (any, error) {
		code, _ := strings.CutPrefix(q.Header.Get("Authorization"), "Bearer ")
		var b struct {
			Info Info `json:"info"`
		}
		if err := q.Decode(&b); err != nil {
			return nil, err
		}
		id, token, err := Join(q.Context(), env.DB, code, b.Info)
		if err != nil {
			return nil, err
		}
		return map[string]string{"host": id, "token": token}, nil
	})
	handle("POST /api/agent/hello", func(q *api.Req, host string) (any, error) {
		var b struct {
			Info Info       `json:"info"`
			Runs []AgentRun `json:"runs"`
		}
		if err := q.Decode(&b); err != nil {
			return nil, err
		}
		ctx := q.Context()
		if err := touch(ctx, env.DB, host, &b.Info, nil); err != nil {
			return nil, err
		}
		open, err := openRuns(ctx, env.DB, host)
		if err != nil {
			return nil, err
		}
		lost, orphans := Reconcile(open, b.Runs)
		for _, l := range lost {
			if err := finishRun(ctx, env.DB, l, Exit{Lost: true}); err != nil {
				return nil, err
			}
			env.Log.Warn("代理不知道这一轮，按退出不明收尾", "host", host, "task", l.Task, "run", l.Run)
		}
		if len(lost) > 0 {
			theHub.notify()
		}
		if orphans == nil {
			orphans = []RunRef{}
		}
		return map[string]any{"stop": orphans}, nil
	})
	handle("POST /api/agent/poll", func(q *api.Req, host string) (any, error) {
		var b struct {
			Load Load `json:"load"`
		}
		if err := q.Decode(&b); err != nil {
			return nil, err
		}
		if err := touch(q.Context(), env.DB, host, nil, &b.Load); err != nil {
			return nil, err
		}
		cmds := theHub.take(q.Context(), host, pollWait)
		if q.Context().Err() != nil {
			return nil, api.Unavailable("服务正在重启或停下")
		}
		if cmds == nil {
			cmds = []Command{}
		}
		return map[string]any{"commands": cmds}, nil
	})
	handle("POST /api/agent/ack", func(q *api.Req, host string) (any, error) {
		var a Ack
		if err := q.Decode(&a); err != nil {
			return nil, err
		}
		if !strings.HasPrefix(a.ID, host+"-") {
			return nil, api.Forbidden("这条指令不是派给 %s 的", host)
		}
		return map[string]bool{"known": theHub.ack(a)}, nil
	})
	handle("POST /api/agent/log", func(q *api.Req, host string) (any, error) {
		var b struct {
			RunRef
			Offset int64  `json:"offset"`
			Data   []byte `json:"data"`
		}
		if err := q.Decode(&b); err != nil {
			return nil, err
		}
		logMu.Lock()
		defer logMu.Unlock()
		ctx := q.Context()
		run, err := ownRun(ctx, env, host, b.RunRef)
		if err != nil {
			return nil, err
		}
		skip, verdict := LogAccept(run.Offset, b.Offset, int64(len(b.Data)))
		if verdict == "append" {
			f, err := os.OpenFile(run.LogFile, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
			if err != nil {
				return nil, err
			}
			_, werr := f.Write(b.Data[skip:])
			if cerr := f.Close(); werr == nil {
				werr = cerr
			}
			if werr != nil {
				return nil, werr
			}
			run.Offset += int64(len(b.Data)) - skip
			if _, err := env.DB.ExecContext(ctx, `UPDATE host_runs SET log_offset = ? WHERE task = ?`, run.Offset, run.Task); err != nil {
				return nil, err
			}
		}
		return map[string]any{"offset": run.Offset, "verdict": verdict}, nil
	})
	handle("POST /api/agent/exit", func(q *api.Req, host string) (any, error) {
		var b struct {
			RunRef
			Code *int  `json:"code"`
			Size int64 `json:"size"`
		}
		if err := q.Decode(&b); err != nil {
			return nil, err
		}
		ctx := q.Context()
		run, err := ownRun(ctx, env, host, b.RunRef)
		if isCode(err, "stale") {
			return map[string]any{"done": true}, nil // 账上已不认这一轮：代理忘掉它
		}
		if err != nil {
			return nil, err
		}
		if run.Offset < b.Size {
			return map[string]any{"done": false, "offset": run.Offset}, nil
		}
		if err := finishRun(ctx, env.DB, b.RunRef, Exit{Code: b.Code, Lost: false}); err != nil {
			return nil, err
		}
		theHub.notify()
		return map[string]any{"done": true}, nil
	})
	handle("POST /api/agent/probe", func(q *api.Req, host string) (any, error) {
		var b struct {
			Failed []ProbeFailure `json:"failed"`
		}
		if err := q.Decode(&b); err != nil {
			return nil, err
		}
		return map[string]int{"failed": len(b.Failed)}, workers.SyncProbes(q.Context(), env.DB, host, probeMarks(b.Failed), store.Now())
	})
	handle("POST /api/agent/quota", func(q *api.Req, host string) (any, error) {
		var b struct {
			Readings []quota.Reading `json:"readings"`
		}
		if err := q.Decode(&b); err != nil {
			return nil, err
		}
		return map[string]int{"recorded": len(b.Readings)}, quota.Record(q.Context(), env.DB, host, b.Readings)
	})
}

// ownRun 取这台机器上这一轮：不是这台的拒绝；已换轮或已退出的报 stale。
func ownRun(ctx context.Context, env *app.Env, host string, ref RunRef) (runRow, error) {
	run, err := getRun(ctx, env.DB, ref.Task)
	if store.IsNotFound(err) {
		return run, &api.Error{Status: 409, Code: "stale", Message: ref.Task + " 没有远程运行"}
	}
	if err != nil {
		return run, err
	}
	if run.Host != host {
		return run, api.Forbidden("%s 不在 %s 上跑", ref.Task, host)
	}
	if run.Run != ref.Run || run.Exited {
		return run, &api.Error{Status: 409, Code: "stale", Message: "这一轮已结束或换了一轮"}
	}
	return run, nil
}

func isCode(err error, code string) bool {
	var ae *api.Error
	return errors.As(err, &ae) && ae.Code == code
}
