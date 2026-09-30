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

// Row 是 workers 列表的一行。
type Row struct {
	ID        string   `json:"id"`
	Trust     string   `json:"trust"`
	MaxRisk   string   `json:"max_risk"`
	Installed bool     `json:"installed"`
	Layers    []string `json:"layers"`
	Stat      Stat     `json:"stat"` // 近 StatWindow 次拉起按结果数（按「工具+模型」，强度不单列）
	Problem   string   `json:"problem,omitempty"`
	Marks     []Mark   `json:"marks,omitempty"` // 哪几台上此刻不可用
}

// Detail 是 workers <名字> 的内容：给执行者标识看叠加结果，给档案名看原文。
type Detail struct {
	Resolved *Resolved `json:"resolved,omitempty"`
	Profile  *Profile  `json:"profile,omitempty"`
	Stat     *Stat     `json:"stat,omitempty"`
	Attempts []Attempt `json:"attempts,omitempty"` // 近 StatWindow 次有结果的拉起，新的在前
	Marks    []Mark    `json:"marks,omitempty"`
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
func Installed(a *Driver) bool {
	_, err := platform.LookPath(a.Exe, platform.WorkerEnv(runtime.GOOS, platform.EnvMap(os.Environ())))
	return err == nil
}

// List 是 workers：可派的执行者、生效规则与近期拉起统计。
func List(ctx context.Context, q store.Querier) ([]Row, error) {
	ids, err := Catalog(ctx, q)
	if err != nil {
		return nil, err
	}
	stats, err := Stats(ctx, q)
	if err != nil {
		return nil, err
	}
	marks, err := Marks(ctx, q, store.Now())
	if err != nil {
		return nil, err
	}
	out := []Row{}
	seen := map[string]bool{}
	counted := map[string]bool{} // 已有行的「工具+模型」
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
		combo := Combo(r.ID)
		counted[combo] = true
		out = append(out, Row{ID: r.ID, Trust: r.Rules.EffectiveTrust(), MaxRisk: r.Rules.EffectiveMaxRisk(),
			Installed: Installed(r.Adapter), Layers: r.Layers, Stat: Count(stats[combo]), Marks: marksOf(marks, r.Spec)})
	}
	// 拉起过、目录里没有的组合（写死派过的）也列出来，统计不丢。
	var extra []string
	for w := range stats {
		if !counted[w] {
			extra = append(extra, w)
		}
	}
	sort.Strings(extra)
	for _, w := range extra {
		s, _ := ParseWorker(w)
		out = append(out, Row{ID: w, Stat: Count(stats[w]), Problem: "不在目录里（写死派过）", Marks: marksOf(marks, s)})
	}
	return out, nil
}

// marksOf 是挡住这个执行者的标记（各台机器上的）。
func marksOf(marks []Mark, s Spec) []Mark {
	var out []Mark
	for _, m := range marks {
		if m.Covers(s) {
			out = append(out, m)
		}
	}
	return out
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
	stats, err := Stats(ctx, q)
	if err != nil {
		return Detail{}, err
	}
	marks, err := Marks(ctx, q, store.Now())
	if err != nil {
		return Detail{}, err
	}
	ls := stats[Combo(r.ID)]
	st := Count(ls)
	return Detail{Resolved: &r, Stat: &st, Attempts: ls, Marks: marksOf(marks, r.Spec)}, nil
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
	r.Handle("POST /api/workers/clear", func(q *api.Req) (any, error) {
		var in struct {
			Target string `json:"target"`
		}
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		n, err := ClearMarks(q.Context(), env.DB, in.Target)
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return nil, api.NotFound("%s 没有不可用标记", in.Target).WithNext("atrium workers")
		}
		return map[string]any{"target": in.Target, "cleared": n}, nil
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

// Commands 注册 workers：列与看只读（执行者连着用户的服务也能跑），改档案与解除标记在 workers edit。
func Commands(t *cli.Table) {
	t.Group("workers", "执行者：可派的组合、档案与近期拉起统计")
	t.Add(cli.Command{Path: "workers", Args: "[执行者或 层/名]",
		Summary: "列执行者（组合、信任、近 20 次拉起的结果、哪台上不可用）；给名字看叠加后的档案与每次拉起的明细，或一层原文",
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
					fmt.Fprintf(&b, "%s  （%s）  %s\n", r.ID, r.Problem, r.Stat)
					continue
				}
				inst := ""
				if !r.Installed {
					inst = "  没装"
				}
				fmt.Fprintf(&b, "%s  trust=%s  max_risk=%s%s  %s\n", r.ID, r.Trust, r.MaxRisk, inst, r.Stat)
				writeMarks(&b, r.Marks)
			}
			return c.Done(rows, b.String(), "atrium workers <执行者>")
		}})
	t.Add(cli.Command{Path: "workers edit", Args: "[层/名]",
		Summary: "改一层档案（--file/--set/--unset/--delete）；--clear 解除不可用标记",
		Flags: []cli.Flag{
			{Name: "clear", Value: "工具[+模型][@机器]", Help: "解除不可用标记（额度用尽、没登录、缺运行环境、模型名无效、零步骤出错退出；自检不过的下次自检跑通自动解除，还不过会再标上）；没写模型或机器就解除这个工具在全部模型或机器上的"},
			{Name: "file", Value: "路径", Help: "整份替换这层档案：--- 包住的 YAML 规则 + 正文（正文附进提示词）"},
			{Name: "set", Value: "键=值", Multi: true, Help: "改一条规则（值按 YAML：trust=medium、checks=[pr_exists]）"},
			{Name: "unset", Value: "键", Multi: true, Help: "删一条规则"},
			{Name: "delete", Bool: true, Help: "删掉这层档案"},
		},
		Run: func(c *cli.Ctx) error {
			if c.Has("clear") {
				return clearCmd(c)
			}
			return editCmd(c)
		}})
}

func clearCmd(c *cli.Ctx) error {
	if err := c.MaxArgs(0); err != nil {
		return err
	}
	target := c.Str("clear")
	if target == "" {
		return api.Usage("--clear: 不能为空")
	}
	var out struct {
		Cleared int `json:"cleared"`
	}
	if err := c.Call("POST", "/api/workers/clear", map[string]any{"target": target}, &out); err != nil {
		return err
	}
	return c.Done(out, fmt.Sprintf("已解除 %s 的 %d 条不可用标记", target, out.Cleared), "atrium workers")
}

func editCmd(c *cli.Ctx) error {
	if err := c.MaxArgs(1); err != nil {
		return err
	}
	name, err := c.Arg(0, "<层/名>")
	if err != nil {
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
	writeMarks(&b, d.Marks)
	if r.CLIModel != "" {
		fmt.Fprintf(&b, "交给工具的模型：%s\n", r.CLIModel)
	} else {
		b.WriteString("交给工具的模型：不传，跟随工具自带的缺省（工具在日志里报了实际模型的，写在下面各次的括号里）\n")
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
	fmt.Fprintf(&b, "档案层：%s\n%s（按 %s 统计，强度不单列）\n", layers, *d.Stat, Combo(r.ID))
	for _, a := range d.Attempts {
		fmt.Fprintf(&b, "  %s  %s 第 %d 次  %s@%s", time.UnixMilli(a.At).Local().Format("01-02 15:04"), a.Task, a.N, a.Worker, a.Host)
		if a.Model != "" {
			fmt.Fprintf(&b, "（%s）", a.Model)
		}
		fmt.Fprintf(&b, "  %s", OutText(a.Outcome))
		if a.Reason != "" && a.Outcome != OutOK {
			fmt.Fprintf(&b, "：%s", clipRunes(oneLine(a.Reason), 80))
		}
		b.WriteString("\n")
	}
	if r.Body != "" {
		fmt.Fprintf(&b, "\n%s\n", r.Body)
	}
	next := "atrium task run <tN> --worker " + r.ID
	return c.Done(d, b.String(), next)
}

// writeMarks 在执行者下面一台一行写不可用标记。
func writeMarks(b *strings.Builder, marks []Mark) {
	for _, m := range marks {
		fmt.Fprintf(b, "  不可用 %s：%s", m.Target(), m.Text())
		if m.Evidence != "" {
			fmt.Fprintf(b, "（%s）", m.Evidence)
		}
		b.WriteString("\n")
	}
}

func fmtTime(ms int64) string { return time.UnixMilli(ms).Format("2006-01-02 15:04") }
