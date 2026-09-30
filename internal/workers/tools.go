package workers

import (
	"context"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// Tool 是主机探测用的工具名与命令；目录由适配器和档案共同拥有。
type Tool struct {
	Name string `json:"name"`
	Exe  string `json:"exe"`
}

func ToolCatalog(ctx context.Context, q store.Querier) ([]Tool, error) {
	out := make([]Tool, 0, len(Tools))
	for _, name := range Tools {
		a, _ := Builtin(name)
		out = append(out, Tool{Name: name, Exe: a.Exe})
	}
	ps, err := ListProfiles(ctx, q)
	if err != nil {
		return nil, err
	}
	for _, p := range ps {
		layer, name, _ := strings.Cut(p.Name, "/")
		if layer != "harness" || p.Keys["protocol"] != "cli" {
			continue
		}
		if _, ok := Builtin(name); ok {
			continue
		}
		r, err := Resolve(ctx, q, name)
		if err != nil {
			return nil, err
		}
		out = append(out, Tool{Name: name, Exe: r.Adapter.Exe})
	}
	return out, nil
}
