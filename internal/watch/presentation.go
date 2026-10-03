package watch

import (
	"strings"

	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/org"
)

// ReadHumanView 为 top、状态栏与秘书简报读取同一份人读全景。
// 原始 Holder 与机器接口保持短号，名册只用于呈现。
func ReadHumanView(c *cli.Ctx) (View, error) {
	var v View
	if err := c.Call("GET", "/api/top", nil, &v); err != nil {
		return v, err
	}
	var roster []org.Identity
	if err := c.Call("GET", "/api/leaders", nil, &roster); err != nil {
		return v, err
	}
	v.Names = make(map[string]string, len(roster))
	for _, identity := range roster {
		v.Names[identity.ID] = identity.Name
	}
	return v, nil
}

// HolderWho 只截长名字，保留完整括号与短号，避免换行字符进入单行呈现。
func (v View) HolderWho(h Holder) string {
	who := org.DisplayIdentity(h.Who, v.Names)
	if who == h.Who {
		return who
	}
	suffix := "（" + h.Who + "）"
	return clip(strings.TrimSuffix(who, suffix), 12) + suffix
}
