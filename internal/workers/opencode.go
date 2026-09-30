package workers

import (
	"encoding/json"
	"github.com/liu-zhengdong/atrium/internal/api"
)

// opencode run：无位置参数时从标准输入读提示词；--format json 逐步输出事件；--auto 全放行，独占。
// 缺省模型写死：opencode models 只列各家模型、不标哪个是缺省，不传 -m 用的是用户配置或上次选的。
func opencodeAdapter() *Driver {
	a := &Driver{Tool: "opencode", Exe: "opencode", DefaultModel: "opencode-go/mimo-v2.6-flash",
		Efforts: []string{"minimal", "low", "medium", "high", "max"}, Exclusive: true, Tell: TellRestart, JSON: true,
		Endpoints: []string{"openai", "anthropic"}, read: readOpencode}
	a.build = func(in Request) (Launch, error) {
		l := Launch{Exe: a.Exe, Dir: in.Dir}
		model := in.Model
		if e := in.Endpoint; e != nil {
			if model == "" {
				return Launch{}, api.Usage("opencode 接自定义端点要写模型名（执行者写 opencode+模型，或档案写 model）")
			}
			opts := map[string]string{"baseURL": e.BaseURL}
			if e.KeyEnv != "" {
				opts["apiKey"] = "{env:" + e.KeyEnv + "}"
			}
			npm := "@ai-sdk/openai-compatible"
			if e.API == "anthropic" {
				npm = "@ai-sdk/anthropic"
			}
			cfg, _ := json.Marshal(map[string]any{"provider": map[string]any{"atrium": map[string]any{
				"npm": npm, "name": "Atrium 自定义端点", "options": opts, "models": map[string]any{model: map[string]string{"name": model}}}}})
			l.Env = map[string]string{"OPENCODE_CONFIG_CONTENT": string(cfg)}
			model = "atrium/" + model
		}
		l.Args = []string{"run", "--format", "json", "--auto"}
		if model != "" {
			l.Args = append(l.Args, "-m", model)
		}
		if in.Effort != "" {
			l.Args = append(l.Args, "--variant", in.Effort)
		}
		l.StdinFile = in.PromptFile
		return l, nil
	}
	return a
}
