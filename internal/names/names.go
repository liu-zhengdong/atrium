// Package names 读取登记名字并呈现机器名，不持久化第二份名册。
package names

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Load 为网页与负责人唤醒读取当前登记资料。
func Load(ctx context.Context, q store.Querier) (map[string]string, error) {
	out := map[string]string{"u1": "你", org.Secretary: "秘书"}
	roster, err := org.Leaders(ctx, q)
	if err != nil {
		return nil, err
	}
	for _, r := range roster {
		out[r.ID] = r.Name
	}
	rows, err := q.QueryContext(ctx, `SELECT id, name FROM hosts ORDER BY CAST(substr(id, 2) AS INTEGER) LIMIT 501`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		count++
		if count > 500 {
			return nil, fmt.Errorf("机器名字超过 500 条")
		}
		out[id] = name
	}
	return out, rows.Err()
}

// Read 为终端读取同一份登记资料，只取展示所需字段。
func Read(c *cli.Ctx) (map[string]string, error) {
	out := map[string]string{"u1": "你", org.Secretary: "秘书"}
	for _, path := range []string{"/api/leaders", "/api/hosts"} {
		var rows []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := c.Call("GET", path, nil, &rows); err != nil {
			return nil, err
		}
		for _, r := range rows {
			out[r.ID] = r.Name
		}
	}
	return out, nil
}

// Host 查不到有效登记名时回落短号；单行出口不带换行。
func Host(id string, names map[string]string) string {
	if name := strings.Join(strings.Fields(names[id]), " "); name != "" {
		return name
	}
	return id
}

var hostSuffix = regexp.MustCompile(`^执行者在做（(h[1-9][0-9]*)）$`)

// HostText 仅用于运行时生成的等待文本，不替换用户正文里的短号。
func HostText(text string, names map[string]string) string {
	match := hostSuffix.FindStringSubmatch(text)
	if match == nil {
		return text
	}
	return "执行者在做（" + Host(match[1], names) + "）"
}

// EventBody 只格式化机器字段与运行时到期文本，事件原文保持不变。
func EventBody(kind, body string, names map[string]string) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(body), &fields) != nil || fields == nil {
		return body
	}
	changed := false
	for _, key := range []string{"host", "text"} {
		if key == "text" && kind != "overdue" {
			continue
		}
		var value string
		if json.Unmarshal(fields[key], &value) != nil {
			continue
		}
		shown := Host(value, names)
		if key == "text" {
			shown = HostText(value, names)
		}
		if shown != value {
			fields[key], _ = json.Marshal(shown)
			changed = true
		}
	}
	if !changed {
		return body
	}
	raw, _ := json.Marshal(fields)
	return string(raw)
}
