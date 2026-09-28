package importer

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Command 是 atrium import：不经服务，直接写新数据目录的库（新库必须是空的）。
// 由 web 模块代为注册（cmd/atrium 的模块列表不为一次性命令单开一格）。命令表有 60 条上限，它不占名额。
func Command() cli.Command {
	return cli.Command{
		Path:    "import",
		Summary: "一次性从旧版（TS）库只读导入部门、要点、决定、负责人、备忘、技能、资料、执行者档案、机器",
		Flags:   []cli.Flag{{Name: "from", Value: "旧库路径", Help: "缺省 ~/.atrium/atrium.sqlite；旧库只读打开，不改动"}},
		Local:   true,
		// 切换时跑一次，之后再没用：不列在帮助里（atrium import --help 照常可看）。
		Hidden: true,
		Run:    run,
	}
}

func run(c *cli.Ctx) error {
	if err := c.MaxArgs(0); err != nil {
		return err
	}
	from := c.Str("from")
	if from == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		from = filepath.Join(home, ".atrium", "atrium.sqlite")
	}
	from, err := filepath.Abs(from)
	if err != nil {
		return err
	}
	p, err := c.Paths()
	if err != nil {
		return err
	}
	db, err := store.Open(p.DB())
	if err != nil {
		return err
	}
	defer db.Close()
	rep, err := Run(c.Context, from, db, p.Data)
	if err != nil {
		return err
	}
	return c.Done(rep, Text(rep, p.Data), "atrium map")
}

// Text 是回执的人读版：每类一行，跳过与超限的原因逐条列出。
func Text(r Report, data string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "已从 %s 导入到 %s：\n", r.From, data)
	for _, it := range r.Items {
		fmt.Fprintf(&b, "  %s：导入 %d", it.Kind, it.Imported)
		if it.Skipped > 0 {
			fmt.Fprintf(&b, "，跳过 %d", it.Skipped)
		}
		b.WriteString("\n")
		for _, n := range it.Notes {
			fmt.Fprintf(&b, "    - %s\n", n)
		}
	}
	b.WriteString("  没搬：任务历史、选项单、周期任务、凭据、章程正文（新版没有这些旧形态）\n")
	if len(r.Over) > 0 {
		b.WriteString("超了上限、已照样导入，请整理：\n")
		for _, o := range r.Over {
			fmt.Fprintf(&b, "  - %s\n", o)
		}
	}
	var ids []string
	for _, k := range sortedKeys(r.Counters) {
		ids = append(ids, fmt.Sprintf("%s%d", k, r.Counters[k]))
	}
	if len(ids) > 0 {
		fmt.Fprintf(&b, "短号接着旧库往后发（旧库最大：%s）\n", strings.Join(ids, " "))
	}
	return b.String()
}
