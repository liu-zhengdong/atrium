package workers

import (
	"context"
	"maps"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Spec 是执行者标识「工具+模型[:强度]」拆开的样子。
type Spec struct {
	Tool   string `json:"tool"`
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
}

func (s Spec) String() string {
	out := s.Tool
	if s.Model != "" {
		out += "+" + s.Model
	}
	if s.Effort != "" {
		out += ":" + s.Effort
	}
	return out
}

// ParseWorker 解析「工具[+模型][:强度]」（纯函数）；工具是否存在由 Resolve 查。
func ParseWorker(v string) (Spec, error) {
	v = strings.TrimSpace(v)
	var s Spec
	head, rest, hasModel := strings.Cut(v, "+")
	target := &head
	if hasModel {
		target = &rest
	}
	if i := strings.LastIndex(*target, ":"); i >= 0 {
		s.Effort = (*target)[i+1:]
		*target = (*target)[:i]
		if !effortRE.MatchString(s.Effort) {
			return s, api.Usage("--worker: 思考强度不合法：%q", s.Effort)
		}
	}
	s.Tool = head
	if !toolRE.MatchString(s.Tool) {
		return s, api.Usage("--worker: 工具名不合法：%q（写成 工具+模型[:强度]，如 dsh+deepseek-official/deepseek-pro:high）", s.Tool)
	}
	if hasModel {
		if !modelRE.MatchString(rest) || strings.Contains("/"+rest, "/.") {
			return s, api.Usage("--worker: 模型不合法：%q", rest)
		}
		s.Model = rest
	}
	return s, nil
}

// ModelKey 是 models/、combos/ 档案名里的模型：取最后一段（去掉 provider 前缀）。
func ModelKey(model string) string { return model[strings.LastIndex(model, "/")+1:] }

// Resolved 是解析后的执行者：适配器、三层叠加的规则与正文。
type Resolved struct {
	// QuotaBinding 由本轮 ResolveExecution 按实际模型给（经 magpie 才有），不落库。
	QuotaBinding *ExecutionBinding `json:"-"`
	ID           string            `json:"id"` // 工具+模型[:强度]（补上默认模型后）
	Spec         Spec              `json:"spec"`
	CLIModel     string            `json:"cli_model,omitempty"` // 实际交给工具的模型：models/combos 层的 model 优先
	Rules        Rules             `json:"rules"`
	Body         string            `json:"body,omitempty"` // 各层正文按 harness、models、combos 拼接，附进提示词
	Layers       []string          `json:"layers"`
	Adapter      *Driver           `json:"-"`
}

// Account 是展示使用的来源类别，不是实际账号或共享套餐身份：模型带 provider 前缀（<provider>/<模型>）
// 就归 provider（实际走 magpie 的那个 provider，不记在工具名下），其余归工具名。
// 执行组合与 provider 分开；provider 保持原名，不建立别名表。
func (r Resolved) Account() string {
	if provider, _, ok := strings.Cut(r.CLIModel, "/"); ok {
		return provider
	}
	if provider, _, ok := strings.Cut(r.Spec.Model, "/"); ok {
		return provider
	}
	return r.Spec.Tool
}

// Endpoint 是档案写的自定义端点；没写为 nil。
func (r Resolved) Endpoint() *Endpoint {
	if r.Rules.Endpoint == "" {
		return nil
	}
	key := ""
	if r.Rules.EndpointKey != "" {
		key = r.Adapter.KeyEnv
		if key == "" {
			key = r.Rules.EndpointKey
		}
	}
	return &Endpoint{BaseURL: r.Rules.Endpoint, API: r.Rules.EndpointAPI, KeyEnv: key}
}

// LocalOnly 是只能派本机的原因（纯函数）：端点是回环地址（localhost、127.x、::1）时只有服务那台机器连得上；否则为空。
func (r Resolved) LocalOnly() string {
	u, err := url.Parse(r.Rules.Endpoint)
	if r.Rules.Endpoint == "" || err != nil {
		return ""
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); host == "localhost" || (ip != nil && ip.IsLoopback()) {
		return "端点 " + r.Rules.Endpoint + " 是本机回环地址，远程机器连不上"
	}
	return ""
}

// Request 按执行者补上模型、强度与端点。
func (r Resolved) Request(prompt, promptFile, dir string) Request {
	return Request{Prompt: prompt, PromptFile: promptFile, Dir: dir, Model: r.CLIModel, Effort: r.Spec.Effort, Endpoint: r.Endpoint()}
}

// MergeLayers 三层叠加（纯函数）：后层的键整项覆盖前层。
func MergeLayers(layers []Profile) (map[string]any, string) {
	keys := map[string]any{}
	var bodies []string
	for _, l := range layers {
		maps.Copy(keys, l.Keys)
		if l.Body != "" {
			bodies = append(bodies, l.Body)
		}
	}
	return keys, strings.Join(bodies, "\n\n")
}

// Resolve 解析执行者标识并读出生效档案。写了模型（标识里或 harness 档案的 model）就固定用它；
// 都没写取适配器缺省（Driver.DefaultModel），它也空就不传模型，跟随工具自带的缺省（最新），ID 只有工具名。
func Resolve(ctx context.Context, q store.Querier, id string) (Resolved, error) {
	s, err := ParseWorker(id)
	if err != nil {
		return Resolved{}, err
	}
	harness, err := GetProfile(ctx, q, "harness/"+s.Tool)
	if err != nil {
		return Resolved{}, err
	}
	a, ok := builtin[s.Tool]
	if !ok {
		return Resolved{}, api.Usage("--worker: 未知的工具 %s，可选 %s", s.Tool, strings.Join(Tools, "、"))
	}
	var layers []Profile
	if harness != nil {
		layers = append(layers, *harness)
	}
	model := s.Model
	if model == "" {
		if m, _ := harness.keyString("model"); m != "" {
			model = m
		} else {
			model = a.DefaultModel
		}
	}
	cliModel := model
	if model != "" {
		for _, name := range []string{"models/" + ModelKey(model), "combos/" + s.Tool + "+" + ModelKey(model)} {
			p, err := GetProfile(ctx, q, name)
			if err != nil {
				return Resolved{}, err
			}
			if p != nil {
				layers = append(layers, *p)
				if m, _ := p.keyString("model"); m != "" {
					cliModel = m
				}
			}
		}
	}
	keys, body := MergeLayers(layers)
	rules, err := decodeRules(keys)
	if err != nil {
		return Resolved{}, err
	}
	rules.Model = cliModel
	if ModelKey(cliModel) == ModelKey(model) {
		model = cliModel // 同一模型只差 provider 前缀时按档案写的算，目录、统计、标记只有一个名字
	}
	full := Spec{Tool: s.Tool, Model: model, Effort: s.Effort}
	out := Resolved{ID: full.String(), Spec: full, CLIModel: cliModel, Rules: rules, Body: body, Adapter: a, Layers: []string{}}
	for _, l := range layers {
		out.Layers = append(out.Layers, l.Name)
	}
	return out, nil
}

func (p *Profile) keyString(k string) (string, bool) {
	if p == nil {
		return "", false
	}
	s, ok := p.Keys[k].(string)
	return s, ok
}

// Check 在分派任务前核对模型与强度搭不搭（不等排到时才报错）。
func (r Resolved) Check() error {
	dir := os.TempDir()
	_, err := r.Adapter.Build(r.Request("检查", filepath.Join(dir, "prompt.md"), dir))
	return err
}
