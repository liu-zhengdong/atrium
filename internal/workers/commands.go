package workers

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Record 是一个执行者的交付事实（运行时从账本数，不来自自述）。
type Record struct {
	Done    int `json:"done"`
	Failed  int `json:"failed"`
	Blocked int `json:"blocked"`
	Active  int `json:"active"`  // 在跑或交付中
	Bounces int `json:"bounces"` // 被交回的次数
}

// Row 是 workers 列表的一行。
type Row struct {
	ID        string   `json:"id"`
	Trust     string   `json:"trust"`
	MaxRisk   string   `json:"max_risk"`
	Installed bool     `json:"installed"`
	Layers    []string `json:"layers"`
	Record    Record   `json:"record"`
	Problem   string   `json:"problem,omitempty"`
}

// Detail 是 workers <名字> 的内容：给执行者标识看叠加结果，给档案名看原文。
type Detail struct {
	Resolved *Resolved `json:"resolved,omitempty"`
	Profile  *Profile  `json:"profile,omitempty"`
	Record   *Record   `json:"record,omitempty"`
}

// Catalog 列可派的执行者：combos 档案里的组合在前（按名字），再是各工具只写工具名（内置按固定顺序，通用命令行执行者随后）。
func Catalog(ctx context.Context, q store.Querier) ([]string, error) {
	ps, err := ListProfiles(ctx, q)
	if err != nil {
		return nil, err
	}
	var combos, custom []string
	for _, p := range ps {
		layer, name, _ := strings.Cut(p.Name, "/")
		switch {
		case layer == "combos":
			combos = append(combos, name)
		case layer == "harness" && p.Keys["protocol"] == "cli":
			custom = append(custom, name)
		}
	}
	return append(append(combos, Tools...), custom...), nil
}

// Installed：子进程环境的 PATH 上找得到这个工具。
func Installed(a *Adapter) bool {
	_, err := platform.LookPath(a.Exe, platform.WorkerEnv(runtime.GOOS, platform.EnvMap(os.Environ())))
	return err == nil
}

// Records 数各执行者的交付事实（按任务上记的执行者）。
func Records(ctx context.Context, q store.Querier) (map[string]Record, error) {
	out := map[string]Record{}
	rows, err := q.QueryContext(ctx, `SELECT worker, status, count(*) FROM tasks WHERE worker != '' GROUP BY worker, status LIMIT 5000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var w, st string
		var n int
		if err := rows.Scan(&w, &st, &n); err != nil {
			return nil, err
		}
		r := out[w]
		switch st {
		case "done":
			r.Done += n
		case "failed":
			r.Failed += n
		case "blocked":
			r.Blocked += n
		case "running", "queued":
			r.Active += n
		}
		out[w] = r
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows2, err := q.QueryContext(ctx, `SELECT t.worker, count(*) FROM task_events e JOIN tasks t ON t.id = e.task
		WHERE e.kind = 'bounce' AND t.worker != '' GROUP BY t.worker LIMIT 5000`)
	if err != nil {
		return nil, err
	}
	defer rows2.Close()
	for rows2.Next() {
		var w string
		var n int
		if err := rows2.Scan(&w, &n); err != nil {
			return nil, err
		}
		r := out[w]
		r.Bounces = n
		out[w] = r
	}
	return out, rows2.Err()
}

// List 是 workers：可派的执行者、生效规则与交付事实。
func List(ctx context.Context, q store.Querier) ([]Row, error) {
	ids, err := Catalog(ctx, q)
	if err != nil {
		return nil, err
	}
	recs, err := Records(ctx, q)
	if err != nil {
		return nil, err
	}
	out := []Row{}
	seen := map[string]bool{}
	for _, id := range ids {
		r, err := Resolve(ctx, q, id)
		if err != nil {
			var ae *api.Error
			if !asAPI(err, &ae) {
				return nil, err
			}
			out = append(out, Row{ID: id, Problem: ae.Message})
			continue
		}
		if seen[r.ID] {
			continue
		}
		seen[r.ID] = true
		out = append(out, Row{ID: r.ID, Trust: r.Rules.EffectiveTrust(), MaxRisk: r.Rules.EffectiveMaxRisk(),
			Installed: Installed(r.Adapter), Layers: r.Layers, Record: recs[r.ID]})
	}
	// 账本里有记录、目录里没有的执行者（写死过的组合）也列出来，交付事实不丢。
	var extra []string
	for w := range recs {
		if !seen[w] {
			extra = append(extra, w)
		}
	}
	sort.Strings(extra)
	for _, w := range extra {
		out = append(out, Row{ID: w, Record: recs[w], Problem: "不在目录里（写死派过）"})
	}
	return out, nil
}

// Show 是 workers <名字>：档案名（含 /）给原文，否则按执行者标识给叠加结果。
func Show(ctx context.Context, q store.Querier, name string) (Detail, error) {
	if strings.Contains(name, "/") && layerNameRE.MatchString(name) {
		p, err := GetProfile(ctx, q, name)
		if err != nil {
			return Detail{}, err
		}
		if p == nil {
			return Detail{}, api.NotFound("档案 %s 不存在", name).WithNext("atrium workers edit " + name + " --file <档案>")
		}
		return Detail{Profile: p}, nil
	}
	r, err := Resolve(ctx, q, name)
	if err != nil {
		return Detail{}, err
	}
	recs, err := Records(ctx, q)
	if err != nil {
		return Detail{}, err
	}
	rec := recs[r.ID]
	return Detail{Resolved: &r, Record: &rec}, nil
}

func asAPI(err error, target **api.Error) bool {
	ae, ok := err.(*api.Error)
	if ok {
		*target = ae
	}
	return ok
}

// Routes 注册执行者接口。
func Routes(r *api.Router, env *app.Env) {
	hook(env)
	r.Handle("GET /api/workers", func(q *api.Req) (any, error) {
		if name := q.URL.Query().Get("name"); name != "" {
			return Show(q.Context(), env.DB, name)
		}
		return List(q.Context(), env.DB)
	})
	r.Handle("POST /api/workers/edit", func(q *api.Req) (any, error) {
		var in struct {
			Name string `json:"name"`
			Edit
		}
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		p, err := SaveProfile(q.Context(), env.DB, in.Name, in.Edit, q.Actor.ID)
		if err != nil {
			return nil, err
		}
		return map[string]any{"name": in.Name, "profile": p}, nil
	})
}

// Commands 注册 workers、workers edit。
func Commands(t *cli.Table) {
	t.Group("workers", "执行者：可派的组合、档案与交付事实")
	t.Add(cli.Command{Path: "workers", Args: "[执行者或档案名]", Summary: "列执行者（组合、信任、交付事实）；给名字看叠加后的档案或一层原文",
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			if len(c.Args) == 1 {
				return showCmd(c, c.Args[0])
			}
			var rows []Row
			if err := c.Call("GET", "/api/workers", nil, &rows); err != nil {
				return err
			}
			var b strings.Builder
			for _, r := range rows {
				if r.Problem != "" {
					fmt.Fprintf(&b, "%s  （%s）  %s\n", r.ID, r.Problem, recordLine(r.Record))
					continue
				}
				inst := ""
				if !r.Installed {
					inst = "  没装"
				}
				fmt.Fprintf(&b, "%s  trust=%s  max_risk=%s%s  %s\n", r.ID, r.Trust, r.MaxRisk, inst, recordLine(r.Record))
			}
			return c.Done(rows, b.String(), "atrium workers <执行者>")
		}})
	t.Add(cli.Command{Path: "workers edit", Args: "<层/名>", Summary: "改执行者档案：harness/<工具>、models/<模型>、combos/<工具>+<模型>",
		Flags: []cli.Flag{
			{Name: "file", Value: "路径", Help: "整份替换：--- 包住的 YAML 规则 + 正文（正文附进提示词）"},
			{Name: "set", Value: "键=值", Multi: true, Help: "改一条规则（值按 YAML：trust=medium、checks=[pr_exists]）"},
			{Name: "unset", Value: "键", Multi: true, Help: "删一条规则"},
			{Name: "delete", Bool: true, Help: "删掉这层档案"},
		},
		Run: func(c *cli.Ctx) error {
			name, err := c.Arg(0, "<层/名>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			e := Edit{Unset: c.List("unset"), Delete: c.Bool("delete")}
			if f := c.Str("file"); f != "" {
				raw, err := os.ReadFile(f)
				if err != nil {
					return api.Usage("--file: 读不了 %s：%v", f, err)
				}
				s := string(raw)
				e.Source = &s
			}
			for _, kv := range c.Values("set") {
				k, v, ok := strings.Cut(kv, "=")
				if !ok || k == "" {
					return api.Usage("--set: 写成 键=值，收到 %q", kv)
				}
				if e.Set == nil {
					e.Set = map[string]string{}
				}
				e.Set[k] = v
			}
			var out struct {
				Name    string   `json:"name"`
				Profile *Profile `json:"profile"`
			}
			if err := c.Call("POST", "/api/workers/edit", map[string]any{"name": name, "source": e.Source, "set": e.Set,
				"unset": e.Unset, "delete": e.Delete}, &out); err != nil {
				return err
			}
			if e.Delete {
				return c.Done(out, "已删档案 "+name, "atrium workers")
			}
			return c.Done(out, "已存档案 "+name, "atrium workers "+name)
		}})
}

func showCmd(c *cli.Ctx, name string) error {
	var d Detail
	if err := c.Call("GET", "/api/workers?"+url.Values{"name": {name}}.Encode(), nil, &d); err != nil {
		return err
	}
	if d.Profile != nil {
		return c.Done(d, strings.TrimRight(d.Profile.Source, "\n")+fmt.Sprintf("\n\n（%s 改于 %s）", d.Profile.UpdatedBy,
			fmtTime(d.Profile.UpdatedAt)), "atrium workers edit "+name+" --set 键=值")
	}
	r := d.Resolved
	var b strings.Builder
	fmt.Fprintf(&b, "%s  trust=%s  max_risk=%s\n", r.ID, r.Rules.EffectiveTrust(), r.Rules.EffectiveMaxRisk())
	if r.CLIModel != "" {
		fmt.Fprintf(&b, "交给工具的模型：%s\n", r.CLIModel)
	}
	if r.Rules.Checks != nil {
		fmt.Fprintf(&b, "checks：%s\n", strings.Join(r.Rules.Checks, "、"))
	}
	if len(r.Rules.Limits) > 0 {
		fmt.Fprintf(&b, "limits：%v\n", r.Rules.Limits)
	}
	if r.Rules.Endpoint != "" {
		fmt.Fprintf(&b, "端点：%s（%s）\n", r.Rules.Endpoint, r.Rules.EndpointAPI)
	}
	layers := "（没有档案，全用缺省）"
	if len(r.Layers) > 0 {
		layers = strings.Join(r.Layers, " ← ")
	}
	fmt.Fprintf(&b, "档案层：%s\n交付：%s\n", layers, recordLine(*d.Record))
	if r.Body != "" {
		fmt.Fprintf(&b, "\n%s\n", r.Body)
	}
	next := "atrium task run <tN> --worker " + r.ID
	return c.Done(d, b.String(), next)
}

func recordLine(r Record) string {
	return fmt.Sprintf("完成 %d · 交回 %d · 失败 %d · 受阻 %d · 在做 %d", r.Done, r.Bounces, r.Failed, r.Blocked, r.Active)
}

func fmtTime(ms int64) string { return time.UnixMilli(ms).Format("2006-01-02 15:04") }
