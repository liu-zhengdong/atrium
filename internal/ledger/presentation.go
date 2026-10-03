package ledger

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/org"
)

// readOwnerTexts 只为本次人读输出加载角色，分批有界，不读取完整任务详情。
// JSON 不增加请求；名字只存在于当前呈现，不回写任务或角色事实。
func readOwnerTexts(c *cli.Ctx, ids []string, names map[string]string) (map[string]string, error) {
	if c.JSON || len(ids) == 0 {
		return nil, nil
	}
	out := make(map[string]string, len(ids))
	for start := 0; start < len(ids); start += partiesBatchSize {
		batch := ids[start:min(start+partiesBatchSize, len(ids))]
		var parties map[string]Parties
		if err := c.Call("GET", "/api/task-parties?ids="+url.QueryEscape(strings.Join(batch, ",")), nil, &parties); err != nil {
			return nil, err
		}
		for _, id := range batch {
			p, ok := parties[id]
			if !ok {
				return nil, fmt.Errorf("任务 %s 缺少角色读取结果", id)
			}
			if p.Owner != "" {
				out[id] = " · 处理人：" + org.DisplayIdentity(p.Owner, names)
			}
		}
	}
	return out, nil
}

// detailNeedsNames 只在详情确有负责人引用时读取名册；纯用户或运行时任务不需要它。
func detailNeedsNames(d Detail) bool {
	if api.IsRef(d.Parties.By, "a") || api.IsRef(d.Parties.Owner, "a") {
		return true
	}
	for _, e := range d.History {
		from, _ := escalationFields(e)
		if api.IsRef(e.Actor, "a") || api.IsRef(from, "a") {
			return true
		}
	}
	return false
}

// escalationFields 只取上报经历的结构字段，不改正文。
// 纯文本经历的上报人是 actor；结构化经历以顶层 from 为准。
func escalationFields(e TaskEvent) (from, label string) {
	if e.Kind != "escalated" {
		return "", ""
	}
	from = e.Actor
	var body struct {
		From  string `json:"from"`
		Label string `json:"label"`
	}
	if json.Unmarshal([]byte(e.Body), &body) == nil {
		if body.From != "" {
			from = body.From
		}
		label = body.Label
	}
	return from, label
}

func escalationReporter(e TaskEvent, names map[string]string) string {
	from, label := escalationFields(e)
	if from == "" {
		return ""
	}
	text := org.DisplayIdentity(from, names)
	if label != "" {
		text += " · " + label
	}
	return text
}
