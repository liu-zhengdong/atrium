package dispatch

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
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// RunResult 是 task run 的结果：入队了给队列位置；--dry-run 给候选与推荐。
type RunResult struct {
	Task     ledger.Task `json:"task"`
	Queued   bool        `json:"queued"`
	Position int         `json:"position,omitempty"`
	Waiting  []string    `json:"waiting,omitempty"` // 还没完成的依赖：都完成后才派
	Pick     *PickView   `json:"pick,omitempty"`
	Host     *HostChoice `json:"host,omitempty"`
}

type runBody struct {
	Options
	DryRun bool `json:"dry_run"`
}

// Routes 注册派活接口。
func Routes(r *api.Router, env *app.Env) {
	hook(env)
	r.AddAuth(authWorker(env))
	r.AddGuard("worker", workerGuard(env))
	r.Handle("POST /api/tasks/{id}/run", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "t")
		if err != nil {
			return nil, err
		}
		var in runBody
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		ctx := q.Context()
		if in.DryRun {
			return dryRun(q, env, id, in.Options)
		}
		if err := ledger.UseDeptRepo(ctx, env.DB, id, q.Actor.ID); err != nil {
			return nil, err
		}
		t, err := Enqueue(ctx, env, id, in.Options, q.Actor.ID)
		if err != nil {
			return nil, err
		}
		pos, err := Position(ctx, env.DB, id)
		if err != nil {
			return nil, err
		}
		deps, err := ledger.Deps(ctx, env.DB, id)
		if err != nil {
			return nil, err
		}
		waiting, _ := ledger.DepGate(deps)
		get(env).wake()
		return RunResult{Task: t, Queued: true, Position: pos, Waiting: waiting}, nil
	})
	r.Handle("POST /api/tasks/{id}/tell", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "t")
		if err != nil {
			return nil, err
		}
		var in struct {
			Text string `json:"text"`
		}
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return Tell(q.Context(), env, id, in.Text, q.Actor.ID)
	})
	r.Handle("GET /api/tasks/{id}/log", func(q *api.Req) (any, error) {
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
		return ReadLog(q.Context(), env, id, offset, wait)
	})
}

func dryRun(q *api.Req, env *app.Env, id string, o Options) (RunResult, error) {
	ctx := q.Context()
	if err := o.check(); err != nil {
		return RunResult{}, err
	}
	t, err := ledger.Get(ctx, env.DB, id)
	if err != nil {
		return RunResult{}, err
	}
	v, err := get(env).view(ctx, t, o.Risk, map[string]bool{}, o.Host)
	if err != nil {
		return RunResult{}, err
	}
	res := RunResult{Task: t, Pick: &v}
	if v.Recommended != "" {
		w, err := workers.ParseWorker(v.Recommended)
		if err != nil {
			return RunResult{}, err
		}
		need, err := hostNeed(ctx, env.DB, w, t)
		if err != nil {
			return RunResult{}, err
		}
		c, err := pickHost(ctx, env, need, o.Host)
		if err != nil {
			return RunResult{}, err
		}
		res.Host = &c
	}
	return res, nil
}

// Commands 注册 task run、task tell、task log（task 组由 ledger 声明）。停下是 ledger 的 task stop（转受阻），派活循环结束它的执行者。
func Commands(t *cli.Table) {
	t.Add(cli.Command{Path: "task run", Args: "<tN>", Summary: "派活：进派活队列（依赖没完成的等完成后再派），自动挑执行者与机器拉起；--dry-run 只看候选与推荐理由",
		Flags: []cli.Flag{
			{Name: "worker", Value: "工具+模型[:强度]", Help: "写死执行者（缺省自动挑：档案能接、紧急／修复或 risk 高于 low 只挑 trust≥medium、额度富余、不正忙）。只写工具 = 跟随工具自带的最新模型（harness/<工具> 档案写了 model 就用它）；写了模型 = 固定"},
			{Name: "risk", Value: "级别", Help: "low（缺省）/ medium / high：执行者档案 max_risk 要够；high 合入前另派审阅"},
			{Name: "host", Value: "hN", Help: "写死机器（缺省本机优先、空位最多）"},
			{Name: "secret", Value: "名称", Multi: true, Help: "派活时按名称注入的凭据（从任务部门往上找）"},
			{Name: "dry-run", Bool: true, Help: "不入队，只列候选、不能接的原因与推荐"},
		},
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<tN>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			body := runBody{Options: Options{Worker: c.Str("worker"), Risk: c.Str("risk"), Host: c.Str("host"), Secrets: c.List("secret")},
				DryRun: c.Bool("dry-run")}
			var res RunResult
			if err := c.Call("POST", "/api/tasks/"+url.PathEscape(id)+"/run", body, &res); err != nil {
				return err
			}
			if body.DryRun {
				return c.Done(res, dryText(res), dryNext(id, res, body.Risk))
			}
			msg, follow := fmt.Sprintf("%s 已进派活队列（第 %d 位）", id, res.Position), "atrium task log "+id+" --follow"
			if len(res.Waiting) > 0 {
				msg = fmt.Sprintf("%s 已进派活队列：等依赖 %s 完成后自动派（依赖失败或取消就转受阻）", id, strings.Join(res.Waiting, "、"))
				follow = "atrium task wait " + res.Waiting[0]
			}
			text, next, err := events.AsyncNext(c, msg, follow)
			if err != nil {
				return err
			}
			return c.Done(res, text, next)
		}})
	t.Add(cli.Command{Path: "task tell", Args: "<tN> <文字>", Summary: "捎话：在跑的执行者按工具即时或本轮后送到，没在跑的下次拉起时写进提示词；交给负责人拆着的投给负责人",
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<tN>")
			if err != nil {
				return err
			}
			text, err := c.Arg(1, "<文字>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(2); err != nil {
				return err
			}
			var r TellResult
			if err := c.Call("POST", "/api/tasks/"+url.PathEscape(id)+"/tell", map[string]string{"text": text}, &r); err != nil {
				return err
			}
			follow := "atrium task log " + id + " --follow"
			if r.Via == "leader" {
				follow = "atrium task show " + id
			}
			text, next, err := events.AsyncNext(c, "已捎话："+r.Note, follow)
			if err != nil {
				return err
			}
			return c.Done(r, text, next)
		}})
	t.Add(cli.Command{Path: "task log", Args: "<tN>", Summary: "看执行者的经过：按它说的话分段，每条命令原文一行（✓ 成功 ✗ 出错 · 没搜到 … 在跑）；--raw 原始日志；--follow 跟到退出",
		Flags: []cli.Flag{{Name: "follow", Bool: true, Help: "跟着看，直到执行者退出"},
			{Name: "raw", Bool: true, Help: "原始日志（从末尾一段起）；日志不是 JSON 事件的工具本来就给原文"}},
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "<tN>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			path := "/api/tasks/" + url.PathEscape(id) + "/log"
			var ch LogChunk
			if err := c.Call("GET", path+"?offset=0", nil, &ch); err != nil {
				return err
			}
			if !c.Bool("raw") && workers.Traceable(ch.Worker) {
				return traceLog(c, id, path, ch)
			}
			if err := c.Call("GET", path, nil, &ch); err != nil {
				return err
			}
			return rawLog(c, id, path, ch)
		}})
}

// TraceView 是 task log 按段看时的结果。
type TraceView struct {
	Task    string        `json:"task"`
	Run     int           `json:"run"`
	Worker  string        `json:"worker"`
	Running bool          `json:"running"`
	Trace   workers.Trace `json:"trace"`
}

// traceLog 从头读完日志按段打出；--follow 时接着等新内容，只打新定下来的部分。
func traceLog(c *cli.Ctx, id, path string, ch LogChunk) error {
	p, pr, follow := workers.NewParser(ch.Worker), &tracePrinter{}, c.Bool("follow")
	show := func(final bool) {
		if !c.JSON {
			fmt.Fprint(c.Env.Stdout, pr.next(p.Trace(), final))
		}
	}
	if !c.JSON {
		fmt.Fprintf(c.Env.Stdout, "== %s 第 %d 次拉起（%s）\n", id, ch.Run, ch.Worker)
	}
	for {
		p.Feed(ch.Text)
		show(false)
		more := ch.Text != ""
		if !more && !(follow && ch.Running) {
			break
		}
		var next LogChunk
		var err error
		if more {
			err = c.Call("GET", path+"?offset="+strconv.FormatInt(ch.Offset, 10), nil, &next)
		} else {
			next, err = followOnce(c, path, ch.Offset)
		}
		if err != nil {
			return err
		}
		if next.Run != ch.Run {
			break // 换了一轮拉起：从新的一轮再看
		}
		ch = next
	}
	show(true)
	if c.JSON {
		return c.Done(TraceView{Task: id, Run: ch.Run, Worker: ch.Worker, Running: ch.Running, Trace: p.Trace()}, "", logNext(id, ch))
	}
	if follow {
		return c.Done(nil, "== 执行者已退出", logNext(id, ch))
	}
	return c.Done(nil, "", logNext(id, ch))
}

// rawLog 给日志原文（末尾一段起）；--follow 跟到退出。
func rawLog(c *cli.Ctx, id, path string, ch LogChunk) error {
	if !c.Bool("follow") {
		return c.Done(ch, fmt.Sprintf("== %s 第 %d 次拉起（%s）\n%s", id, ch.Run, ch.Worker, ch.Text), logNext(id, ch))
	}
	var all strings.Builder
	all.WriteString(ch.Text)
	if !c.JSON {
		fmt.Fprintf(c.Env.Stdout, "== %s 第 %d 次拉起（%s）\n%s", id, ch.Run, ch.Worker, ch.Text)
	}
	for ch.Running {
		next, err := followOnce(c, path, ch.Offset)
		if err != nil {
			return err
		}
		if next.Run != ch.Run {
			break // 换了一轮拉起：从新的一轮再看
		}
		ch = next
		all.WriteString(ch.Text)
		if !c.JSON {
			fmt.Fprint(c.Env.Stdout, ch.Text)
		}
	}
	ch.Text = all.String()
	if c.JSON {
		return c.Done(ch, "", logNext(id, ch))
	}
	return c.Done(nil, "== 执行者已退出", logNext(id, ch))
}

// followOnce 等下一段日志；服务平滑重启时等新服务起来再接着读。
func followOnce(c *cli.Ctx, path string, offset int64) (LogChunk, error) {
	deadline := time.Now().Add(30 * time.Second)
	for {
		var ch LogChunk
		err := c.Call("GET", path+"?wait=1&offset="+strconv.FormatInt(offset, 10), nil, &ch)
		var ae *api.Error
		if err == nil || !errors.As(err, &ae) || (ae.Code != "restarting" && ae.Code != "not_running") || time.Now().After(deadline) {
			return ch, err
		}
		time.Sleep(300 * time.Millisecond)
		c.ResetClient()
	}
}

func logNext(id string, ch LogChunk) string {
	if ch.Running {
		return "atrium task log " + id + " --follow"
	}
	return "atrium task show " + id
}

func dryText(r RunResult) string {
	var b strings.Builder
	v := r.Pick
	fmt.Fprintf(&b, "%s（risk %s）\n", r.Task.ID, v.Risk)
	for _, c := range v.Candidates {
		mark := "  "
		if c.ID == v.Recommended {
			mark = "→ "
		}
		extra := "  " + c.Stat.Timing()
		if c.Spare != nil {
			extra += fmt.Sprintf("  富余 %.1f%%", *c.Spare)
		}
		if c.Busy {
			extra += "  正忙"
		}
		if Shaky(c.Fails) {
			extra += fmt.Sprintf("  近 %d 次拉起启动失败 %d 次", ShakyWindow, c.Fails)
		}
		if c.Eligible {
			fmt.Fprintf(&b, "%s%d. %s  trust=%s  max_risk=%s%s\n", mark, c.Rank, c.ID, c.Trust, c.MaxRisk, extra)
		} else {
			fmt.Fprintf(&b, "%s×  %s：%s\n", mark, c.ID, strings.Join(c.Refusals, "；")+"  "+c.Stat.Timing())
		}
	}
	fmt.Fprintf(&b, "推荐：%s\n", v.Reason)
	if r.Host != nil {
		b.WriteString(hostLine(r.Host.Kind, r.Host.Host, r.Host.Reason) + "\n")
	}
	return b.String()
}

// hostLine 是 --dry-run 的机器一行（纯函数）：在哪台拉起、排队或接不了；没有原因不写括号。
func hostLine(kind, host, reason string) string {
	s := "机器："
	switch kind {
	case "run":
		s += "在 " + host + " 拉起"
	case "queue":
		s += "排队"
		if host != "" {
			s += "等 " + host
		}
	case "refuse":
		s += "接不了"
	default:
		s += kind + " " + host
	}
	if reason != "" {
		s += "（" + reason + "）"
	}
	return s
}

func dryNext(id string, r RunResult, risk string) string {
	if r.Pick.Recommended == "" {
		return "atrium workers"
	}
	next := "atrium task run " + id + " --worker " + r.Pick.Recommended
	if risk != "" {
		next += " --risk " + risk
	}
	return next
}
