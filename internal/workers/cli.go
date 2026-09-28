package workers

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
)

// CLISpec 是通用命令行执行者（harness/<名字> 写 protocol: cli）的写法，不写代码就能接一个新工具。
// args 元素里可用占位 {prompt} {prompt_file} {cwd} {model} {effort} {base_url}；整个元素写
// {model_args} {effort_args} {endpoint_args} 时换成对应参数组，这次没给模型、强度、端点就整组省掉。
// 没有 {prompt} 也没有 {prompt_file} 时提示词从标准输入给。done_match / error_match 是逐行匹配的正则。
type CLISpec struct {
	Command      string            `yaml:"command"`
	Args         []string          `yaml:"args"`
	ModelArgs    []string          `yaml:"model_args"`
	EffortArgs   []string          `yaml:"effort_args"`
	EndpointArgs []string          `yaml:"endpoint_args"`
	Efforts      []string          `yaml:"efforts"`
	DoneMatch    string            `yaml:"done_match"`
	ErrorMatch   string            `yaml:"error_match"`
	Env          map[string]string `yaml:"env"`
	EndpointAPIs []string          `yaml:"endpoint_apis"`
	KeyEnv       string            `yaml:"key_env"`
	Exclusive    bool              `yaml:"exclusive"`
	JSON         bool              `yaml:"json"`
}

var (
	placeholders = []string{"prompt", "prompt_file", "cwd", "model", "effort", "base_url"}
	groupOf      = map[string]string{"model_args": "model", "effort_args": "effort", "endpoint_args": "base_url"}
	tokenRE      = regexp.MustCompile(`\{([a-z_]+)\}`)
	envNameRE    = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)
)

func tokens(s string) []string {
	var out []string
	for _, m := range tokenRE.FindAllStringSubmatch(s, -1) {
		out = append(out, m[1])
	}
	return out
}

// Problems 列出写法的毛病（纯函数）；空表示能用。
func (s CLISpec) Problems(name string) []string {
	var p []string
	if !toolRE.MatchString(name) {
		p = append(p, fmt.Sprintf("工具名 %s 不合法：小写字母开头，只含小写字母、数字、连字符", name))
	}
	if _, ok := builtin[name]; ok {
		p = append(p, fmt.Sprintf("%s 是内置工具，不能写 protocol", name))
	}
	if s.Command == "" || strings.ContainsAny(s.Command, `/\ `) || strings.HasPrefix(s.Command, "-") {
		p = append(p, "command 只写 PATH 上的命令名，不带路径、空白或参数；参数写在 args")
	}
	used := map[string]bool{}
	check := func(where string, items []string, groupsOK bool) {
		for _, it := range items {
			for _, tk := range tokens(it) {
				used[tk] = true
				if _, isGroup := groupOf[tk]; isGroup {
					if !groupsOK || it != "{"+tk+"}" {
						p = append(p, fmt.Sprintf("{%s} 只能在 args 里单独占一项", tk))
					}
				} else if !slices.Contains(placeholders, tk) {
					p = append(p, fmt.Sprintf("%s 里的 {%s} 不是占位，可用 {prompt} {prompt_file} {cwd} {model} {effort} {base_url} {model_args} {effort_args} {endpoint_args}", where, tk))
				}
			}
		}
	}
	check("args", s.Args, true)
	check("model_args", s.ModelArgs, false)
	check("effort_args", s.EffortArgs, false)
	check("endpoint_args", s.EndpointArgs, false)
	for g, items := range map[string][]string{"model_args": s.ModelArgs, "effort_args": s.EffortArgs, "endpoint_args": s.EndpointArgs} {
		if len(items) > 0 && !used[g] {
			p = append(p, fmt.Sprintf("写了 %s，但 args 里没有 {%s} 标出放在哪", g, g))
		}
	}
	if len(s.Efforts) > 0 && !used["effort"] {
		p = append(p, "写了 efforts，但 args 里没用 {effort} 或 {effort_args}")
	}
	if len(s.Efforts) == 0 && used["effort"] {
		p = append(p, "用了 {effort}，但没写 efforts（接受哪些强度）")
	}
	if used["prompt"] && used["prompt_file"] {
		p = append(p, "{prompt} 与 {prompt_file} 只用一个")
	}
	for _, re := range []struct{ k, v string }{{"done_match", s.DoneMatch}, {"error_match", s.ErrorMatch}} {
		if re.v != "" {
			if _, err := regexp.Compile(re.v); err != nil {
				p = append(p, fmt.Sprintf("%s 不是合法正则：%v", re.k, err))
			}
		}
	}
	for k, v := range s.Env {
		if !envNameRE.MatchString(k) || strings.HasPrefix(k, "ATRIUM_") || k == "PATH" || k == "HOME" {
			p = append(p, fmt.Sprintf("env.%s：变量名须大写字母、数字、下划线，不能盖 PATH、HOME 与 ATRIUM_*", k))
		}
		for _, tk := range tokens(v) {
			if tk != "model" && tk != "base_url" {
				p = append(p, fmt.Sprintf("env.%s 里只能用 {model}、{base_url}", k))
			}
		}
	}
	for _, a := range s.EndpointAPIs {
		if !slices.Contains(EndpointAPIs, a) {
			p = append(p, fmt.Sprintf("endpoint_apis 里的 %s 不认识，可用 %s", a, strings.Join(EndpointAPIs, "、")))
		}
	}
	if s.KeyEnv != "" && !envNameRE.MatchString(s.KeyEnv) {
		p = append(p, "key_env 须是大写的环境变量名")
	}
	return p
}

// cliAdapter 把写法变成适配器；调用前先看 Problems。
func cliAdapter(name string, s CLISpec) *Adapter {
	all := strings.Join(append(append(append(append([]string{}, s.Args...), s.ModelArgs...), s.EffortArgs...), s.EndpointArgs...), " ")
	for _, v := range s.Env {
		all += " " + v
	}
	apis := s.EndpointAPIs
	if len(apis) == 0 {
		apis = []string{"openai"}
	}
	if !strings.Contains(all, "{base_url}") && !strings.Contains(all, "{endpoint_args}") {
		apis = nil
	}
	a := &Adapter{Tool: name, Exe: s.Command, Efforts: s.Efforts, Exclusive: s.Exclusive, Tell: TellRestart, JSON: s.JSON,
		Endpoints: apis, KeyEnv: s.KeyEnv, ArgPrompt: strings.Contains(all, "{prompt}"), cli: &s}
	if len(s.Efforts) == 0 {
		a.Efforts = nil
	}
	a.build = func(in Request) (Launch, error) {
		vals := map[string]string{"prompt": in.Prompt, "prompt_file": in.PromptFile, "cwd": in.Dir}
		if in.Model != "" {
			vals["model"] = in.Model
		}
		if in.Effort != "" {
			vals["effort"] = in.Effort
		}
		if in.Endpoint != nil {
			vals["base_url"] = in.Endpoint.BaseURL
		}
		args, err := ExpandArgs(name, s, vals)
		if err != nil {
			return Launch{}, err
		}
		l := Launch{Exe: s.Command, Args: args, Dir: in.Dir}
		if !strings.Contains(all, "{prompt}") && !strings.Contains(all, "{prompt_file}") {
			l.StdinFile = in.PromptFile
		}
		for k, tpl := range s.Env {
			if v, ok := fill(tpl, vals); ok {
				if l.Env == nil {
					l.Env = map[string]string{}
				}
				l.Env[k] = v
			}
		}
		return l, nil
	}
	return a
}

func fill(tpl string, vals map[string]string) (string, bool) {
	ok := true
	out := tokenRE.ReplaceAllStringFunc(tpl, func(m string) string {
		v, has := vals[m[1:len(m)-1]]
		ok = ok && has
		return v
	})
	return out, ok
}

// ExpandArgs 按模板展开参数（纯函数）：整组标记在值缺时省掉，其余占位缺值报错。
func ExpandArgs(name string, s CLISpec, vals map[string]string) ([]string, error) {
	groups := map[string][]string{"model_args": s.ModelArgs, "effort_args": s.EffortArgs, "endpoint_args": s.EndpointArgs}
	var out []string
	add := func(item string) error {
		v, ok := fill(item, vals)
		if !ok {
			return api.Usage("harness/%s 的 args 用了 %s，但这次没有对应的值；可选的参数放进 model_args、effort_args、endpoint_args 组", name, item)
		}
		out = append(out, v)
		return nil
	}
	for _, item := range s.Args {
		if g, ok := groups[strings.Trim(item, "{}")]; ok && item == "{"+strings.Trim(item, "{}")+"}" {
			if _, has := vals[groupOf[strings.Trim(item, "{}")]]; !has {
				continue
			}
			for _, part := range g {
				if err := add(part); err != nil {
					return nil, err
				}
			}
			continue
		}
		if err := add(item); err != nil {
			return nil, err
		}
	}
	return out, nil
}
