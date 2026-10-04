package quota

import (
	"fmt"
	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
)

type settings struct {
	Reserve int `json:"reserve"`
}

type setBody struct {
	Reserve *int `json:"reserve,omitempty"`
}

func Routes(r *api.Router, env *app.Env) {
	r.Handle("POST /api/quota", func(q *api.Req) (any, error) {
		if q.Actor.Kind != "user" {
			return nil, api.Forbidden("只有用户能改额度设置")
		}
		var b setBody
		if err := q.Decode(&b); err != nil {
			return nil, err
		}
		ctx := q.Context()
		if b.Reserve != nil {
			if *b.Reserve < 0 || *b.Reserve > 90 {
				return nil, api.Usage("--reserve: 应为 0 到 90 的整数，收到 %d", *b.Reserve)
			}
			if _, err := env.DB.ExecContext(ctx, `INSERT INTO quota_settings (name, value) VALUES ('reserve_percent', ?)
				ON CONFLICT (name) DO UPDATE SET value = excluded.value`, *b.Reserve); err != nil {
				return nil, err
			}
		}
		reserve, err := Reserve(ctx, env.DB)
		return settings{Reserve: reserve}, err
	})
}

func Commands(t *cli.Table) {
	t.Group("quota", "额度设置；各套餐余量在 OpenQuota/magpie 面板看")
	t.Add(cli.Command{Path: "quota set", Summary: "改额度设置（只有用户能改）",
		Flags: []cli.Flag{
			{Name: "reserve", Value: "百分比", Help: "给用户留的份额（缺省 20），账号已用到 100 减它就不再派任务"},
		},
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(0); err != nil {
				return err
			}
			if !c.Has("reserve") {
				return api.Usage("--reserve: 必填")
			}
			n, err := c.Int("reserve", 0)
			if err != nil {
				return err
			}
			var result settings
			if err := c.Call("POST", "/api/quota", setBody{Reserve: &n}, &result); err != nil {
				return err
			}
			return c.Done(result, fmt.Sprintf("给用户留 %d%%", result.Reserve), "atrium quota --help")
		}})
}
