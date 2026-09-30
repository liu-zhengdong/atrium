package service

import (
	"os"
	"strconv"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
)

// Status 是 GET /api/status 的内容。
type Status struct {
	PID       int           `json:"pid"`
	Port      int           `json:"port"`
	Version   string        `json:"version"`
	Data      string        `json:"data"`
	StartedAt int64         `json:"started_at"`
	Pauses    []pause.Entry `json:"pauses"`
}

type scopeBody struct {
	Scope string `json:"scope"`
}

func (s *server) routes(r *api.Router) {
	r.Public("GET /health", func(q *api.Req) (any, error) {
		return map[string]any{"pid": os.Getpid(), "version": Version}, nil
	})
	r.Handle("GET /api/status", func(q *api.Req) (any, error) {
		list, err := s.env.Pause.List(q.Context())
		if err != nil {
			return nil, err
		}
		return Status{PID: os.Getpid(), Port: s.env.Port, Version: Version, Data: s.env.Paths.Data,
			StartedAt: s.started, Pauses: list}, nil
	})
	r.Handle("POST /api/service/stop", func(q *api.Req) (any, error) {
		s.request("stop")
		return map[string]int{"pid": os.Getpid()}, nil
	})
	// 平滑重启：先拉起新进程（它等端口），再停下自己；在跑的执行者是独立进程组，不受影响。
	r.Handle("POST /api/service/restart", func(q *api.Req) (any, error) {
		base := platform.EnvMap(os.Environ())
		base["ATRIUM_PORT"] = strconv.Itoa(s.env.Port) // 新进程接手同一个端口（系统挑的也一样）
		pid, _, _, err := spawnServe(s.env.Paths, base, os.Getpid())
		if err != nil {
			return nil, err
		}
		s.request("restart")
		return map[string]int{"old_pid": os.Getpid(), "new_pid": pid}, nil
	})
	r.Handle("POST /api/auth/rotate", func(q *api.Req) (any, error) {
		return map[string]string{"token_file": s.env.Paths.Token()}, s.rotate()
	})
	r.Handle("POST /api/pause", func(q *api.Req) (any, error) {
		var b scopeBody
		if err := q.Decode(&b); err != nil {
			return nil, err
		}
		if err := s.env.Pause.Set(q.Context(), b.Scope, q.Actor.ID); err != nil {
			return nil, err
		}
		return s.env.Pause.List(q.Context())
	})
	r.Handle("POST /api/resume", func(q *api.Req) (any, error) {
		var b scopeBody
		if err := q.Decode(&b); err != nil {
			return nil, err
		}
		was, err := s.env.Pause.Clear(q.Context(), b.Scope)
		if err != nil {
			return nil, err
		}
		if !was {
			return nil, api.Conflict("%s 本来就没暂停", b.Scope).WithNext("atrium status")
		}
		return s.env.Pause.List(q.Context())
	})
}
