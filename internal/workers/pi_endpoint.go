package workers

import (
	"encoding/json"
	"path/filepath"

	"github.com/liu-zhengdong/atrium/internal/api"
)

// pi 没有指定端点的命令行参数，自定义 provider 只能写进 ~/.pi/agent/models.json（用户的配置）或由扩展注册。
// 档案写了端点时，Atrium 在这次运行的记录旁生成一个扩展，注册名为 atrium 的 provider，模型就是档案的 model，
// 拉起时 -e 加载、--model atrium/<模型>；用户的 pi 配置不动。
// 单价写 0：pi 报的金额为 0 时按没报算，花费由档案 prices 估算（与其他工具同一口径）。
// 上下文与单次输出上限取保守值：pi 按它决定何时压缩，端点那头的真实上限这里不知道。
const (
	piEndpointProvider = "atrium"
	piEndpointFile     = "pi-endpoint.js"
	piEndpointContext  = 200000
	piEndpointOutput   = 32000
)

var piEndpointAPIs = map[string]string{"openai": "openai-completions", "anthropic": "anthropic-messages"}

// piEndpointExt 算出扩展的路径与内容（纯函数）；文件放在提示词文件旁（本机与远程都是这次运行的目录）。
func piEndpointExt(in Request) (path, src string, err error) {
	e := in.Endpoint
	if in.Model == "" {
		return "", "", api.Usage("pi 接自定义端点要写模型名（执行者写 pi+模型，或档案写 model）")
	}
	if in.PromptFile == "" {
		return "", "", api.Usage("pi 接自定义端点要有提示词文件（扩展写在它旁边）")
	}
	key := "atrium" // 本机网关（如 magpie）不认客户端的 key，但 pi 要有 key 才认为模型可用
	if e.KeyEnv != "" {
		key = "$" + e.KeyEnv
	}
	cfg, err := json.Marshal(map[string]any{
		"baseUrl": e.BaseURL, "api": piEndpointAPIs[e.API], "apiKey": key,
		"models": []map[string]any{{
			"id": in.Model, "name": in.Model, "reasoning": in.Effort != "", "input": []string{"text"},
			"cost":          map[string]float64{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
			"contextWindow": piEndpointContext, "maxTokens": piEndpointOutput,
		}},
	})
	if err != nil {
		return "", "", err
	}
	src = "export default function (pi) {\n  pi.registerProvider(" + quoteJS(piEndpointProvider) + ", " + string(cfg) + ");\n}\n"
	return filepath.Join(filepath.Dir(in.PromptFile), piEndpointFile), src, nil
}

func quoteJS(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
