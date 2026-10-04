package dispatch

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func taskLogRoute(q *api.Req, env *app.Env) (any, error) {
	id, err := q.Ref("id", "t")
	if err != nil {
		return nil, err
	}
	offset := int64(-1)
	if v := q.URL.Query().Get("offset"); v != "" {
		if offset, err = strconv.ParseInt(v, 10, 64); err != nil || offset < 0 {
			return nil, api.Usage("offset: 应为非负整数")
		}
	}
	wait := time.Duration(0)
	if q.URL.Query().Get("wait") == "1" {
		wait = 25 * time.Second
	}
	n := 0
	if v := q.URL.Query().Get("run"); v != "" {
		n, err = strconv.Atoi(v)
		if err != nil || n < 1 {
			return nil, api.Usage("run: 应为正整数")
		}
	}
	return readRunLog(q.Context(), env, id, n, offset, wait, q.URL.Query().Get("complete") == "1")
}
func logQuery(path, query string) string {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return path + sep + query
}
func taskLog(c *cli.Ctx) error {
	id, err := c.Arg(0, "<tN>")
	if err != nil {
		return err
	}
	if err := c.MaxArgs(1); err != nil {
		return err
	}
	if c.Bool("all") && c.JSON {
		return api.Usage("--all: 完整原文请去掉 --json，重定向输出到文件；JSON按块读取请使用日志接口offset")
	}
	if c.Bool("all") && !c.Bool("raw") {
		return api.Usage("--all: 需配合 --raw")
	}
	path := "/api/tasks/" + url.PathEscape(id) + "/log"
	if v := c.Str("run"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return api.Usage("--run: 应为正整数")
		}
		path = logQuery(path, "run="+strconv.Itoa(n))
	}
	if c.Bool("all") {
		path = logQuery(path, "complete=1")
	}
	var ch LogChunk
	if err := c.Call("GET", logQuery(path, "offset=0"), nil, &ch); err != nil {
		return err
	}
	if v := c.Str("run"); v != "" {
		n, _ := strconv.Atoi(v)
		if n != ch.Run {
			return api.Conflict("服务返回第%d轮，与请求第%s轮不符；当前服务尚未支持历史轮次入口", ch.Run, v)
		}
	}
	if c.Bool("all") && !ch.Complete {
		return api.Conflict("服务尚未支持完整原文读取；不能把尾段当完整日志")
	}
	// 固定本次选择的轮次，分页和跟随不会混入重派后的内容。
	if c.Str("run") == "" {
		path = logQuery(path, "run="+strconv.Itoa(ch.Run))
	}
	if !c.Bool("raw") && workers.Traceable(ch.Worker) {
		return traceLog(c, id, path, ch)
	}
	if c.Bool("all") {
		return completeLog(c, id, path, ch)
	}
	if err := c.Call("GET", path, nil, &ch); err != nil {
		return err
	}
	return rawLog(c, id, path, ch)
}
func completeLog(c *cli.Ctx, id, path string, ch LogChunk) error {
	// 完整原文直接流式写出，避免整份日志积在内存。
	for {
		if _, err := fmt.Fprint(c.Env.Stdout, ch.Text); err != nil {
			return err
		}
		if ch.Text == "" {
			if !c.Bool("follow") || !ch.Running {
				return nil
			}
			next, err := followOnce(c, path, ch.Offset)
			if err != nil {
				return err
			}
			ch = next
		} else {
			var next LogChunk
			if err := c.Call("GET", logQuery(path, "offset="+strconv.FormatInt(ch.Offset, 10)), nil, &next); err != nil {
				return err
			}
			ch = next
		}
	}
}
