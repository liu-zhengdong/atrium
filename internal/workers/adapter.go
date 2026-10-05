package workers

import (
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/platform"
)

// 补充说明（task tell）怎么送到：本轮结束后按会话继续、停掉带着补充重派。
const (
	TellResume  = "resume"
	TellRestart = "restart"
)

// 自定义模型端点的接口种类。
var EndpointAPIs = []string{"openai", "responses", "anthropic"}

// Request 是一次拉起的输入，全是纯数据：远程代理收到它（Dir、PromptFile 由代理按自己机器填）也用 Build 算出同样的调用。
type Request struct {
	Task       string    `json:"task"`
	Prompt     string    `json:"prompt"`
	PromptFile string    `json:"prompt_file,omitempty"` // 绝对路径；走标准输入的工具读它
	Dir        string    `json:"dir,omitempty"`         // 工作目录（绝对路径，有仓库时是 worktree）
	Model      string    `json:"model,omitempty"`       // 交给工具的模型 id；空表示交给工具自己的配置
	Effort     string    `json:"effort,omitempty"`
	Session    string    `json:"session,omitempty"` // 非空表示带着补充继续这个会话
	Endpoint   *Endpoint `json:"endpoint,omitempty"`
}

// Build 按工具名算出进程调用（纯函数）：内置工具用内置适配器。
func Build(tool string, req Request) (Launch, error) {
	a, ok := builtin[tool]
	if !ok {
		return Launch{}, api.Usage("未知的工具 %s", tool)
	}
	return a.Build(req)
}

// Endpoint 是档案写的自定义模型端点；KeyEnv 是密钥所在的环境变量（值由分派任务方按凭据名注入）。
type Endpoint struct {
	BaseURL string `json:"base_url"`
	API     string `json:"api"`
	KeyEnv  string `json:"key_env,omitempty"`
}

// Launch 是算好的进程调用。Exe 是 PATH 上的程序名，由拉起方按子进程环境 LookPath。
type Launch struct {
	Exe       string            `json:"exe"`
	Args      []string          `json:"args"`
	Dir       string            `json:"dir"`
	StdinFile string            `json:"stdin_file,omitempty"` // 接到标准输入的文件；空表示不接
	StdinData string            `json:"stdin_data,omitempty"` // 工具要求结构化标准输入时的内容
	Env       map[string]string `json:"env,omitempty"`        // 白名单环境之上额外设的变量（不放密钥）
	Files     map[string]string `json:"files,omitempty"`      // 拉起前写好的文件：绝对路径 → 内容（不放密钥）
}

// WriteFiles 写出 Launch.Files；本机与远程拉起前都调。
func (l Launch) WriteFiles() error {
	for path, src := range l.Files {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(src), 0o600); err != nil {
			return err
		}
	}
	return nil
}

// Adapter 把一次请求翻成进程调用（经 platform.Start 拉起）。远程代理（hosts）按它拉起；*Driver 实现它。
type Adapter interface {
	Name() string
	Spec(req Request, env map[string]string) (platform.Spec, error)
}

// Driver 是一个内置工具的数据与翻译函数。
type Driver struct {
	Tool         string
	Exe          string
	DefaultModel string   // 只写工具、档案也没写 model 时交给工具的模型；空表示不传，跟随工具自带的缺省（最新）
	Efforts      []string // nil 表示不接受思考强度
	Exclusive    bool     // 同一时刻只跑一个
	Tell         string
	JSON         bool     // 标准输出是逐行 JSON 事件（内置工具须同时带 read，测试核对）
	Endpoints    []string // 能接的端点接口种类
	KeyEnv       string   // 端点密钥交给工具时用的变量名；空则用档案 endpoint_key 本身
	ArgPrompt    bool     // 提示词走命令行参数（有长度上限）
	build        func(in Request) (Launch, error)
	read         reader // 怎么读它的日志攒成经过（tracers.go）；nil 表示按原文逐行看
	session      *regexp.Regexp
}

// Name 是工具名。
func (a *Driver) Name() string { return a.Tool }

// Build 把输入翻成进程调用（纯函数）。
func (a *Driver) Build(in Request) (Launch, error) {
	if err := a.check(in); err != nil {
		return Launch{}, err
	}
	return a.build(in)
}

// SessionOf 从日志开头取会话 id（继续时用）；取不到或工具不支持返回空。
func (a *Driver) SessionOf(log string) string {
	if a.session == nil {
		return ""
	}
	if m := a.session.FindStringSubmatch(log); m != nil {
		return m[1]
	}
	return ""
}

// CanResume：补充说明本轮结束后能不能按会话继续。
func (a *Driver) CanResume() bool { return a.session != nil && a.Tell != TellRestart }

const argPromptMax = 256 * 1024

// modelSeg 是模型名的一段：主体后可带一个方括号档位后缀（官方命名如 GLM-5.3[1m] 的 1M 上下文档），
// 后缀只能在段尾、至多一个、里面不嵌方括号。
const modelSeg = `[\w.@-]+(\[[^\[\]]+\])?`

var (
	modelRE   = regexp.MustCompile(`^` + modelSeg + `(/` + modelSeg + `)*$`)
	effortRE  = regexp.MustCompile(`^[a-z]+$`)
	sessionRE = regexp.MustCompile(`^[0-9a-f-]{36}$`)
	toolRE    = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
)

func (a *Driver) check(in Request) error {
	if !filepath.IsAbs(in.Dir) {
		return api.Usage("工作目录须为绝对路径：%s", in.Dir)
	}
	if strings.TrimSpace(in.Prompt) == "" {
		return api.Usage("提示词为空")
	}
	if in.Model != "" && !modelRE.MatchString(in.Model) {
		return api.Usage("模型 id 不合法：%s", in.Model)
	}
	if in.Effort != "" {
		if a.Efforts == nil {
			return api.Usage("%s 不接受思考强度，去掉 :%s", a.Tool, in.Effort)
		}
		if !slices.Contains(a.Efforts, in.Effort) {
			return api.Usage("%s 的思考强度只能是 %s，收到 %s", a.Tool, strings.Join(a.Efforts, "、"), in.Effort)
		}
	}
	if a.ArgPrompt && len(in.Prompt) > argPromptMax {
		return api.Usage("%s 的提示词走命令行参数，%d 字节超过上限 %d", a.Tool, len(in.Prompt), argPromptMax)
	}
	if in.Session != "" && !sessionRE.MatchString(in.Session) {
		return api.Usage("会话 id 不合法：%s", in.Session)
	}
	if in.Endpoint != nil && !slices.Contains(a.Endpoints, in.Endpoint.API) {
		if len(a.Endpoints) == 0 {
			return api.Usage("%s 不支持自定义模型端点", a.Tool)
		}
		return api.Usage("%s 只能接 %s 接口的端点，档案写的是 %s", a.Tool, strings.Join(a.Endpoints, "、"), in.Endpoint.API)
	}
	return nil
}

var builtin = map[string]*Driver{}

// Tools 是内置工具的固定顺序（没有额度数据时按它挑）。
var Tools = []string{"dsh"}

func init() {
	for _, a := range []*Driver{dshAdapter()} {
		builtin[a.Tool] = a
	}
}

// Builtin 取内置适配器。
func Builtin(tool string) (*Driver, bool) {
	a, ok := builtin[tool]
	return a, ok
}

// Spec 给远程代理：按请求算出进程调用并按子进程环境找程序。
// 走标准输入的提示词直接从 req.Prompt 给，不要求那台有提示词文件。
func (a *Driver) Spec(req Request, env map[string]string) (platform.Spec, error) {
	if req.PromptFile == "" {
		f, err := os.CreateTemp("", "atrium-prompt-*.md")
		if err != nil {
			return platform.Spec{}, err
		}
		_, err = f.WriteString(req.Prompt)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return platform.Spec{}, err
		}
		req.PromptFile = f.Name()
	}
	l, err := Build(a.Tool, req)
	if err != nil {
		return platform.Spec{}, err
	}
	if err := l.WriteFiles(); err != nil {
		return platform.Spec{}, err
	}
	envs := maps.Clone(env)
	maps.Copy(envs, l.Env)
	exe, err := platform.LookPath(l.Exe, envs)
	if err != nil {
		return platform.Spec{}, err
	}
	s := platform.Spec{Path: exe, Args: l.Args, Dir: l.Dir, Env: envs}
	if l.StdinData != "" {
		s.Stdin = strings.NewReader(l.StdinData)
	} else if l.StdinFile != "" {
		s.Stdin = strings.NewReader(req.Prompt)
	}
	return s, nil
}
