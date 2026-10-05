package workers

import (
	"context"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// Tool 是主机探测用的工具名与命令。
type Tool struct {
	Name string `json:"name"`
	Exe  string `json:"exe"`
}

// ToolCatalog 是主机自检要探的工具：内置的那几个。
func ToolCatalog(ctx context.Context, q store.Querier) ([]Tool, error) {
	out := make([]Tool, 0, len(Tools))
	for _, name := range Tools {
		a, _ := Builtin(name)
		out = append(out, Tool{Name: name, Exe: a.Exe})
	}
	return out, nil
}
