package workers

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Row 是 workers 列表的一行。
type Row struct {
	ID        string   `json:"id"`
	Auto      bool     `json:"auto"`
	Prefer    bool     `json:"prefer,omitempty"`
	Trust     string   `json:"trust"`
	MaxRisk   string   `json:"max_risk"`
	Installed bool     `json:"installed"`
	Layers    []string `json:"layers"`
	Recent    []string `json:"recent"` // 每次结果，新的在前
	Stat      Stat     `json:"stat"`   // 近 StatWindow 次拉起按结果数（按「工具+模型」，强度不单列）
	Problem   string   `json:"problem,omitempty"`
	Marks     []Mark   `json:"marks,omitempty"` // 哪几台上此刻不可用
}

// Detail 是 workers <名字> 的内容：给执行者标识看叠加结果，给档案名看原文。
type Detail struct {
	Quota  *quota.Line `json:"quota,omitempty"` // 存下的额度读数；没有时仅含账号
	Timing string      `json:"timing"`          // 用时说明，与命令行共用 Stat.Timing

	Trust    string    `json:"trust,omitempty"` // 生效值，与目录相同
	MaxRisk  string    `json:"max_risk,omitempty"`
	Resolved *Resolved `json:"resolved,omitempty"`
	Profile  *Profile  `json:"profile,omitempty"`
	Stat     *Stat     `json:"stat,omitempty"`
	Quality  *Quality  `json:"quality,omitempty"`  // 窗口内质量（QualityWindow），与近期统计同口径
	Attempts []Attempt `json:"attempts,omitempty"` // 近 StatWindow 次有结果的拉起，新的在前
	Marks    []Mark    `json:"marks,omitempty"`
	Layers   []Profile `json:"layers"`
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
		out = append(out, Row{ID: r.ID, Auto: r.Rules.EffectiveAuto(), Prefer: r.Rules.Prefer, Trust: r.Rules.EffectiveTrust(), MaxRisk: r.Rules.EffectiveMaxRisk(),
			Installed: Installed(r.Adapter), Layers: r.Layers, Stat: Count(stats[combo]), Recent: recentOutcomes(stats[combo]), Marks: marksOf(marks, r.Spec)})
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
		out = append(out, Row{ID: w, Stat: Count(stats[w]), Recent: recentOutcomes(stats[w]), Problem: "不在目录里（写死派过）", Marks: marksOf(marks, s)})
	}
	return out, nil
}

// recentOutcomes 保留 Stats 的结果顺序，供目录行显示。
func recentOutcomes(ls []Attempt) []string {
	out := []string{}
	for _, a := range ls {
		out = append(out, a.Outcome)
	}
	return out
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
	qualities, err := ReadQuality(ctx, q)
	if err != nil {
		return Detail{}, err
	}
	quality := Quality{Combo: Combo(r.ID), BounceReasons: map[string]int{}}
	for _, v := range qualities {
		if v.Combo == quality.Combo && !v.Leader {
			quality = v
			break
		}
	}
	layers := []Profile{}
	for _, name := range r.Layers {
		p, err := GetProfile(ctx, q, name)
		if err != nil {
			return Detail{}, err
		}
		if p == nil {
			return Detail{}, api.NotFound("档案 %s 不存在", name)
		}
		layers = append(layers, *p)
	}
	return Detail{Timing: st.Timing(), Trust: r.Rules.EffectiveTrust(), MaxRisk: r.Rules.EffectiveMaxRisk(), Resolved: &r, Stat: &st, Quality: &quality, Attempts: ls, Marks: marksOf(marks, r.Spec), Layers: layers}, nil
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
	quota.DisabledAccounts = disabledQuotaAccounts
	hook(env)
	r.Handle("GET /api/workers/quality", func(q *api.Req) (any, error) {
		return ReadQuality(q.Context(), env.DB)
	})
	r.Handle("GET /api/workers", func(q *api.Req) (any, error) {
		if name := q.URL.Query().Get("name"); name != "" {
			return showWithQuota(q.Context(), env, name)
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
	r.Handle("POST /api/workers/wait-subscription", func(q *api.Req) (any, error) {
		var in struct {
			Target string `json:"target"`
		}
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		n, err := WaitSubscription(q.Context(), env.DB, in.Target, store.Now())
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return nil, api.NotFound("--wait-subscription: %s 没有不可用标记，先有标记才能转成等订阅恢复", in.Target).WithNext("atrium workers")
		}
		return map[string]any{"target": in.Target, "changed": n}, nil
	})
	r.Handle("POST /api/workers/recount", func(q *api.Req) (any, error) {
		var in struct {
			Task string `json:"task"`
		}
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return Recount(q.Context(), env.DB, in.Task, q.Actor.ID)
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
	ledger.HistoryText[ExitKind] = ExitText
	ledger.HistoryText[RecountKind] = RecountText
	t.Group("workers", "执行者：可派的组合、档案与近期拉起统计")
	t.Add(cli.Command{Path: "workers chrome-mcp", Local: true, Hidden: true,
		Summary: "执行者 Chrome MCP 入口", Args: "[-- MCP 参数]",
		Run: func(c *cli.Ctx) error { return runChromeMCP(c.Args, os.Stdin, c.Env.Stdout, c.Env.Stderr) }})
	t.Add(cli.Command{Path: "workers", Args: "[执行者或 层/名]",
		Summary: "列执行者；--quality 看质量汇总；给名字看档案、质量与近 20 次明细",
		Detail:  qualityHelp,
		Flags:   []cli.Flag{{Name: "quality", Bool: true, Help: "按组合列近期质量汇总（不带名字），按交付率、花费、用时排序"}},
		Run: func(c *cli.Ctx) error {
			if c.Bool("quality") {
				return qualityCmd(c)
			}
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
				if !r.Auto {
					inst = "  只点名"
				} else if r.Prefer {
					inst = "  优先"
				}
				if !r.Installed {
					inst += "  没装"
				}
				fmt.Fprintf(&b, "%s  trust=%s  max_risk=%s%s  %s\n", r.ID, r.Trust, r.MaxRisk, inst, r.Stat)
				writeMarks(&b, r.Marks)
			}
			return c.Done(rows, b.String(), "atrium workers <执行者>")
		}})
	t.Add(cli.Command{Path: "workers edit", Args: "[层/名]",
		Summary: "改一层档案（--file/--set/--unset/--delete）；--clear 解除不可用标记；--recount 按当前档案补算一件任务的用量",
		Flags: []cli.Flag{
			{Name: "clear", Value: "工具[+模型][@机器]", Help: "解除不可用标记（额度用尽、没登录、缺运行环境、工具版本过旧、模型名无效、零步骤出错退出；自检不过的下次自检跑通自动解除，还不过会再标上）；没写模型或机器就解除这个工具在全部模型或机器上的"},
			{Name: "wait-subscription", Value: "工具[+模型][@机器]", Help: "把已有的不可用标记转成等订阅恢复（订阅已封号、重登修不好）：照样不派活，但不进网页「等你」、不出登录指引；用户明说恢复后再 --clear。匹配规则同 --clear"},
			{Name: "file", Value: "路径", Help: "整份替换这层档案：--- 包住的 YAML 规则 + 正文（正文附进提示词）"},
			{Name: "set", Value: "键=值", Multi: true, Help: "改一条规则（值按 YAML：auto=false（只点名）、prefer=true（自动挑人时优先，--unset prefer 解除）、trust=medium、checks=[pr_exists]）"},
			{Name: "unset", Value: "键", Multi: true, Help: "删一条规则"},
			{Name: "delete", Bool: true, Help: "删掉这层档案"},
			{Name: "recount", Value: "tN", Help: "按当前档案从日志重新结算这件任务每次拉起的 token 与花费，覆盖退出记录里的结果（改了 usage 或 prices 后补算历史用；日志不在就报错）"},
		},
		Run: func(c *cli.Ctx) error {
			if c.Has("clear") {
				return clearCmd(c)
			}
			if c.Has("wait-subscription") {
				return waitSubscriptionCmd(c)
			}
			if c.Has("recount") {
				return recountCmd(c)
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

func waitSubscriptionCmd(c *cli.Ctx) error {
	if err := c.MaxArgs(0); err != nil {
		return err
	}
	target := c.Str("wait-subscription")
	if target == "" {
		return api.Usage("--wait-subscription: 不能为空")
	}
	var out struct {
		Changed int `json:"changed"`
	}
	if err := c.Call("POST", "/api/workers/wait-subscription", map[string]any{"target": target}, &out); err != nil {
		return err
	}
	return c.Done(out, fmt.Sprintf("已把 %s 的 %d 条不可用标记转成等订阅恢复", target, out.Changed), "atrium workers")
}

func recountCmd(c *cli.Ctx) error {
	if err := c.MaxArgs(0); err != nil {
		return err
	}
	task := c.Str("recount")
	if task == "" {
		return api.Usage("--recount: 不能为空")
	}
	var out []Recounted
	if err := c.Call("POST", "/api/workers/recount", map[string]any{"task": task}, &out); err != nil {
		return err
	}
	var b strings.Builder
	for _, r := range out {
		fmt.Fprintf(&b, "第 %d 次拉起 · %s\n", r.N, r.After.String())
	}
	return c.Done(out, b.String(), "atrium task show "+task)
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
