package workers

import (
	"fmt"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"net/url"
	"strings"
	"time"
)

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
	fmt.Fprintf(&b, "额度：%s\n", quotaText(*d.Quota))
	writeMarks(&b, d.Marks)
	if r.CLIModel != "" {
		fmt.Fprintf(&b, "交给工具的模型：%s\n", r.CLIModel)
	} else {
		b.WriteString("交给工具的模型：不传，跟随工具自带的缺省（工具在日志里报了实际模型的，写在下面各次的括号里）\n")
	}
	if r.Rules.Checks != nil {
		fmt.Fprintf(&b, "checks：%s\n", strings.Join(r.Rules.Checks, "、"))
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
		fmt.Fprintf(&b, "  %s · 用时 %s · %s", OutText(a.Outcome), DurationText(a.DurationMS), a.Usage.String())
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

func fmtTime(ms int64) string { return time.UnixMilli(ms).Format("2006-01-02 15:04") }
