package leaders

import (
	"context"
	"fmt"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Module 是负责人运行时的接入点：负责人令牌认证与权限判定、上报接口与命令、唤醒循环。
func Module() app.Module { return moduleFor(newHub()) }

func moduleFor(h *hub) app.Module {
	return app.Module{Name: "leaders", Commands: commands, Run: h.run,
		Routes: func(r *api.Router, env *app.Env) {
			r.AddAuth(h.auth)
			MaterialsOverview = func(ctx context.Context, q store.Querier, dept string) (string, error) {
				return org.Overview(ctx, q, env.Paths.Data, dept)
			}
			r.AddGuard("leader", guard(env.DB))
			r.Handle("POST /api/escalations", func(q *api.Req) (any, error) {
				if q.Actor.Kind != "leader" {
					return nil, api.Forbidden("只有负责人（唤醒时的令牌）能上报；用户直接处理即可")
				}
				var in EscalateIn
				if err := q.Decode(&in); err != nil {
					return nil, err
				}
				return Escalate(q.Context(), env.DB, q.Actor.ID, in)
			})
		}}
}

func commands(t *cli.Table) {
	t.Add(cli.Command{Path: "leader escalate", Args: "<说明>", Summary: "负责人上报：要别的部门配合、越权、无法解决、知会用户",
		Flags: []cli.Flag{
			{Name: "kind", Value: "cross|beyond|stuck|notify", Help: "上报哪一类（必填）"},
			{Name: "task", Value: "tN", Help: "关于哪件任务"},
			{Name: "event", Value: "编号", Help: "转交下层上报给你的那条事件"},
		},
		Run: func(c *cli.Ctx) error {
			note, err := c.Arg(0, "<说明>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			ev, err := c.Int("event", 0)
			if err != nil {
				return err
			}
			var out Escalation
			in := EscalateIn{Kind: c.Str("kind"), Note: note, Task: c.Str("task"), Event: int64(ev)}
			if err := c.Call("POST", "/api/escalations", in, &out); err != nil {
				return err
			}
			if out.Kind == "notify" {
				return c.Done(out, "已知会秘书；不需回复，继续派活", "atrium task run <tN>")
			}
			return c.Done(out, fmt.Sprintf("已上报 %s（%s）", out.To, kindLabel(out.Kind)), "atrium events ack <编号>")
		}})
}
