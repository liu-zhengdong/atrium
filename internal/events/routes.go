package events

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/org"
)

func Module() app.Module {
	return app.Module{Name: "events", Commands: Commands, Routes: Routes, Run: run}
}

const (
	maxWait      = time.Hour
	defaultWait  = 10 * time.Minute
	defaultBatch = 2 * time.Second
)

// subscriber 定订阅者：用户可以替任何订阅者取（缺省 secretary）；负责人只能是自己。
func subscriber(q *api.Req) (string, error) {
	as := strings.TrimSpace(q.URL.Query().Get("as"))
	switch q.Actor.Kind {
	case "user":
		if as == "" {
			return Secretary, nil
		}
		if as != Secretary && !api.IsRef(as, "a") {
			return "", api.Usage("--as: 应为 secretary 或 aN，收到 %q", as)
		}
		return as, nil
	case "leader":
		if as != "" && as != q.Actor.ID {
			return "", api.Forbidden("负责人 %s 只能取自己的事件", q.Actor.ID)
		}
		return q.Actor.ID, nil
	}
	return "", api.Forbidden("%s 不能取事件", q.Actor.Kind)
}

// ListenBody 是报「在听」的请求体。
type ListenBody struct {
	As         string `json:"as"`
	Via        string `json:"via"`
	TTLSeconds int    `json:"ttl_seconds"`
	Stop       bool   `json:"stop"`
}

func Routes(r *api.Router, env *app.Env) {
	db := env.DB
	r.Handle("GET /api/events/wait", func(q *api.Req) (any, error) {
		as, err := subscriber(q)
		if err != nil {
			return nil, err
		}
		timeout := defaultWait
		if v := q.URL.Query().Get("timeout"); v != "" {
			sec, err := strconv.Atoi(v)
			if err != nil || sec < 0 || time.Duration(sec)*time.Second > maxWait {
				return nil, api.Usage("--timeout: 应为 0–3600 的秒数")
			}
			timeout = time.Duration(sec) * time.Second
		}
		batch := defaultBatch
		if timeout == 0 {
			batch = 0
		}
		return Wait(q.Context(), db, WaitOpts{Target: as, All: q.URL.Query().Get("all") == "1", Timeout: timeout, Batch: batch})
	})
	r.Handle("POST /api/events/ack", func(q *api.Req) (any, error) {
		var in struct {
			IDs []int64 `json:"ids"`
		}
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		if len(in.IDs) == 0 || len(in.IDs) > 500 {
			return nil, api.Usage("<编号>: 给 1–500 个事件编号")
		}
		only := ""
		switch q.Actor.Kind {
		case "user":
		case "leader":
			only = q.Actor.ID
		default:
			return nil, api.Forbidden("%s 不能确认事件", q.Actor.Kind)
		}
		return Ack(q.Context(), db, in.IDs, only, q.Actor.ID)
	})
	r.Handle("POST /api/events/listen", func(q *api.Req) (any, error) {
		var in ListenBody
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		if q.Actor.Kind != "user" {
			return nil, api.Forbidden("只有秘书会话（用户令牌）能报在听")
		}
		if in.As == "" {
			in.As = Secretary
		}
		if in.TTLSeconds <= 0 || in.TTLSeconds > 600 {
			in.TTLSeconds = 90
		}
		Listen(in.As, in.Via, time.Duration(in.TTLSeconds)*time.Second, in.Stop)
		return Listening(in.As), nil
	})
	r.Handle("GET /api/events/pushed", func(q *api.Req) (any, error) {
		return map[string]bool{"pushed": Pushed(q.Actor, Listening(Secretary) != nil)}, nil
	})
	r.Handle("GET /api/events/listen", func(q *api.Req) (any, error) {
		as := q.URL.Query().Get("as")
		if as == "" {
			as = Secretary
		}
		return map[string]any{"listener": Listening(as)}, nil
	})
}

func Commands(t *cli.Table) {
	t.Group("events", "事件")
	t.Add(cli.Command{Path: "events wait", Summary: "等要处理的事件：有了就取走（15 分钟内不重投），处理完 events ack",
		Flags: []cli.Flag{
			{Name: "as", Value: "订阅者", Help: "替谁取：secretary（缺省）或 aN；负责人令牌只能取自己的"},
			{Name: "timeout", Value: "秒", Help: "最多等多久（缺省 600，0 表示只看一眼）"},
			{Name: "all", Bool: true, Help: "连知会一起取（缺省只取要处理的）"},
		},
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(0); err != nil {
				return err
			}
			q := url.Values{}
			if v := c.Str("as"); v != "" {
				q.Set("as", v)
			}
			if v := c.Str("timeout"); v != "" {
				q.Set("timeout", v)
			}
			if c.Bool("all") {
				q.Set("all", "1")
			}
			var rows []Row
			if err := CallSurvivingRestart(c, "GET", "/api/events/wait?"+q.Encode(), nil, &rows); err != nil {
				return err
			}
			if len(rows) == 0 {
				return c.Done(rows, "没有新事件", "atrium events wait")
			}
			var names map[string]string
			if !c.JSON {
				var err error
				names, err = ReadNames(c)
				if err != nil {
					return err
				}
			}
			var b strings.Builder
			ids := make([]string, len(rows))
			for i, r := range rows {
				ids[i] = strconv.FormatInt(r.ID, 10)
				fmt.Fprintln(&b, Line(r, names))
			}
			return c.Done(rows, b.String(), "atrium events ack "+strings.Join(ids, " "))
		}})
	t.Add(cli.Command{Path: "events ack", Args: "<编号>…", Summary: "确认事件：处理完了，不再投",
		Run: func(c *cli.Ctx) error {
			if len(c.Args) == 0 {
				return api.Usage("缺少 <编号>").WithNext("atrium events wait")
			}
			var ids []int64
			for _, a := range c.Args {
				for _, p := range strings.Split(strings.TrimPrefix(a, "#"), ",") {
					if p = strings.TrimSpace(strings.TrimPrefix(p, "#")); p == "" {
						continue
					}
					n, err := strconv.ParseInt(p, 10, 64)
					if err != nil || n <= 0 {
						return api.Usage("<编号>: 应为正整数，收到 %q", p)
					}
					ids = append(ids, n)
				}
			}
			var res AckResult
			if err := c.Call("POST", "/api/events/ack", map[string]any{"ids": ids}, &res); err != nil {
				return err
			}
			text := fmt.Sprintf("已确认 %d 条", len(res.Acked))
			if len(res.Already) > 0 {
				text += fmt.Sprintf("；%d 条早已确认", len(res.Already))
			}
			if len(res.Missing) > 0 {
				text += fmt.Sprintf("；没有这些事件（或不是发给你的）：%v", res.Missing)
			}
			text, next, err := AsyncNext(c, text, "atrium events wait")
			if err != nil {
				return err
			}
			return c.Done(res, text, next)
		}})
}

// Line 是 CLI 与秘书共用的事件摘要：#编号 任务 要点（合并次数） · 收件人。
func Line(r Row, names map[string]string) string {
	parts := []string{fmt.Sprintf("#%d", r.ID)}
	if r.Task != "" {
		parts = append(parts, r.Task)
	}
	parts = append(parts, Summary(r, names))
	if r.Count > 1 {
		parts = append(parts, fmt.Sprintf("（合并 %d 次）", r.Count))
	}
	line := strings.Join(parts, " ")
	if r.Target != "" {
		target := org.DisplayIdentity(r.Target, names)
		if r.Target == Secretary {
			target = "秘书"
		}
		line += " · 收件人：" + target
	}
	return line
}

// CallSurvivingRestart：服务平滑重启时长轮询会被打断（restarting）或短暂连不上，等新服务起来后重发（最多 30 秒）。
func CallSurvivingRestart(c *cli.Ctx, method, path string, body, out any) error {
	deadline := time.Now().Add(30 * time.Second)
	for {
		err := c.Call(method, path, body, out)
		var ae *api.Error
		if !errors.As(err, &ae) || (ae.Code != "restarting" && ae.Code != "not_running") || time.Now().After(deadline) {
			return err
		}
		time.Sleep(300 * time.Millisecond)
		c.ResetClient()
	}
}
