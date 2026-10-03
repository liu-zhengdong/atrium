package events

import (
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/org"
)

// ReadNames 在人读事件或注入批次呈现时读取当前名册，不写入事件事实。
func ReadNames(c *cli.Ctx) (map[string]string, error) {
	var roster []org.Identity
	if err := c.Call("GET", "/api/leaders", nil, &roster); err != nil {
		return nil, err
	}
	names := make(map[string]string, len(roster))
	for _, identity := range roster {
		names[identity.ID] = identity.Name
	}
	return names, nil
}
