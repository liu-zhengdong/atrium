package workers

import (
	"context"
	"maps"
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
		return s, api.Usage("--worker: 工具名不合法：%q（写成 工具+模型[:强度]，如 claude+opus:high）", s.Tool)
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
	ID       string   `json:"id"` // 工具+模型[:强度]（补上默认模型后）
	Spec     Spec     `json:"spec"`
	CLIModel string   `json:"cli_model,omitempty"` // 实际交给工具的模型：models/combos 层的 model 优先
	Rules    Rules    `json:"rules"`
	Body     string   `json:"body,omitempty"` // 各层正文按 harness、models、combos 拼接，附进提示词
	Layers   []string `json:"layers"`
	Adapter  *Adapter `json:"-"`
}

// Account 是额度账号：同一工具的模型共享一份额度。
func (r Resolved) Account() string { return r.Spec.Tool }

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

// Request 按执行者补上模型、强度、端点与通用命令行写法。
func (r Resolved) Request(prompt, promptFile, dir string) Request {
	return Request{Prompt: prompt, PromptFile: promptFile, Dir: dir, Model: r.CLIModel, Effort: r.Spec.Effort, Endpoint: r.Endpoint(),
		CLI: r.Adapter.cli}
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

// Resolve 解析执行者标识并读出生效档案。只写工具时模型取 harness 档案的 model，再退回适配器缺省。
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
		if harness == nil || harness.Keys["protocol"] != "cli" {
			return Resolved{}, api.Usage("--worker: 未知的工具 %s，可选 %s，或先写 harness/%s 档案（protocol: cli）接进来",
				s.Tool, strings.Join(Tools, "、"), s.Tool).WithNext("atrium workers edit harness/" + s.Tool + " --file <档案>")
		}
		r, err := decodeRules(harness.Keys)
		if err != nil {
			return Resolved{}, err
		}
		if p := r.CLISpec.Problems(s.Tool); len(p) > 0 {
			return Resolved{}, api.Usage("harness/%s 写得不对：%s", s.Tool, strings.Join(p, "；"))
		}
		a = cliAdapter(s.Tool, r.CLISpec)
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

// Check 在派活前核对模型与强度搭不搭（不等排到时才报错）。
func (r Resolved) Check() error {
	dir := os.TempDir()
	_, err := r.Adapter.Build(r.Request("检查", filepath.Join(dir, "prompt.md"), dir))
	return err
}
