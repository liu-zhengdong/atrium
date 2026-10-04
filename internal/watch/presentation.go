package watch

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/names"
	"github.com/liu-zhengdong/atrium/internal/org"
)

// ReadHumanView 为 top、状态栏与秘书简报读取同一份人读全景。
// 原始 Holder 与机器接口保持短号，名册只用于呈现。
func ReadHumanView(c *cli.Ctx) (View, error) {
	var v View
	if err := c.Call("GET", "/api/top", nil, &v); err != nil {
		return v, err
	}
	var err error
	v.Names, err = names.Read(c)
	if err != nil {
		return v, err
	}
	return v, nil
}

// readTopView 只给 top 的父任务行补当前处理人；等待对象仍是子任务，不改 Holder。
// /api/top 最多返回 500 件任务，角色读取也至多一批 500 件；不读取完整详情或扫描经历正文。
func readTopView(c *cli.Ctx) (View, error) {
	v, err := ReadHumanView(c)
	if err != nil {
		return v, err
	}
	var ids []string
	for _, t := range v.Tasks {
		if t.Holder.Kind == "children" {
			ids = append(ids, t.ID)
		}
	}
	if len(ids) == 0 {
		return v, nil
	}
	var parties map[string]ledger.Parties
	if err := c.Call("GET", "/api/task-parties?ids="+url.QueryEscape(strings.Join(ids, ",")), nil, &parties); err != nil {
		return v, err
	}
	v.Owners = make(map[string]string, len(ids))
	for _, id := range ids {
		p, ok := parties[id]
		if !ok {
			return v, fmt.Errorf("任务 %s 缺少角色读取结果", id)
		}
		v.Owners[id] = p.Owner
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
