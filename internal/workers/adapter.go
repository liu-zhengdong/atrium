package workers

import (
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/platform"
)

// 补充说明（task tell）怎么送到：即时写标准输入、本轮结束后按会话继续、停掉带着补充重派。
const (
	TellStdin   = "stdin"
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
	Live       bool      `json:"live,omitempty"`    // 标准输入保持打开，运行中补充说明即时写入（只有 TellStdin 的工具）
	Session    string    `json:"session,omitempty"` // 非空表示带着补充继续这个会话
	Endpoint   *Endpoint `json:"endpoint,omitempty"`
	CLI        *CLISpec  `json:"cli,omitempty"` // 通用命令行执行者的写法（远程没有档案库，随请求带过去）
	// 本机工具（codex 的 computer use -c 覆盖），由拉起那台机器经 LocalTools 填，服务端不填
	ComputerUse []string `json:"computer_use,omitempty"`
}

// Build 按工具名算出进程调用（纯函数）：内置工具用内置适配器，通用命令行执行者用 req.CLI。
func Build(tool string, req Request) (Launch, error) {
	if req.CLI != nil {
		if p := req.CLI.Problems(tool); len(p) > 0 {
			return Launch{}, api.Usage("harness/%s 写得不对：%s", tool, strings.Join(p, "；"))
		}
		return cliAdapter(tool, *req.CLI).Build(req)
	}
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
	Live      bool              `json:"live,omitempty"`       // 标准输入是消息流：先写 StdinFile 内容作第一条消息，之后写补充说明
	Env       map[string]string `json:"env,omitempty"`        // 白名单环境之上额外设的变量（不放密钥）
}

// Adapter 把一次请求翻成进程调用（经 platform.Start 拉起）。远程代理（hosts）按它拉起；*Driver 实现它。
type Adapter interface {
	Name() string
	Spec(req Request, env map[string]string) (platform.Spec, error)
}

// Driver 是一个工具的数据与翻译函数（内置工具各一个，通用命令行执行者按档案现造）。
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
	cli          *CLISpec
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

var (
	modelRE   = regexp.MustCompile(`^[\w.@-]+(/[\w.@-]+)*$`)
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
			return api.Usage("%s 不支持自定义模型端点；能接的：opencode（openai、anthropic）、codex（responses）、claude（anthropic），其他用通用命令行执行者（protocol: cli）", a.Tool)
		}
		return api.Usage("%s 只能接 %s 接口的端点，档案写的是 %s", a.Tool, strings.Join(a.Endpoints, "、"), in.Endpoint.API)
	}
	if in.Live && a.Tell != TellStdin {
		return api.Usage("%s 不能即时送补充说明", a.Tool)
	}
	return nil
}

var builtin = map[string]*Driver{}

// Tools 是内置工具的固定顺序（没有额度数据时按它挑）。
var Tools = []string{"claude", "codex", "opencode", "cursor", "agy", "kimi", "grok"}

func init() {
	for _, a := range []*Driver{claudeAdapter(), codexAdapter(), opencodeAdapter(), cursorAdapter(), agyAdapter(), kimiAdapter(), grokAdapter()} {
		builtin[a.Tool] = a
	}
}

// Builtin 取内置适配器。
func Builtin(tool string) (*Driver, bool) {
	a, ok := builtin[tool]
	return a, ok
}

// UserLine 是 stream-json 标准输入的一条用户消息（claude 格式）。
func UserLine(text, uuid string) []byte {
	b, _ := json.Marshal(map[string]any{"type": "user", "uuid": uuid, "session_id": "", "parent_tool_use_id": nil,
		"message": map[string]any{"role": "user", "content": text}})
	return append(b, '\n')
}

var initSession = regexp.MustCompile(`"type":"system","subtype":"init"[^\n]*?"session_id":"([0-9a-f-]{36})"`)

// claude -p：stream-json 逐轮输出事件（进展信号）；--input-format stream-json 让标准输入成为消息流，
// 运行中写入的用户消息在工具调用边界读入，--replay-user-messages 把读入的消息带 isReplay 回显。
// --setting-sources 不含 local：工作树顺着读到主检出的 .claude/settings.local.json（用户个人设置，
// 秘书目录在那里写着 env ATRIUM_AS=secretary 与起秘书桥的 SessionStart hook），执行者不该带上。
// --strict-mcp-config：只带 Atrium 显式给出的 MCP（执行者会话的工具集见 computeruse.go）。
// 缺省模型 opus 是 CLI 的别名，跟随最新的 Opus；不传 --model 会用用户 settings.json 里的 model。
func claudeAdapter() *Driver {
	a := &Driver{Tool: "claude", Exe: "claude", DefaultModel: "opus", Efforts: []string{"low", "medium", "high", "xhigh", "max"},
		Tell: TellStdin, JSON: true, Endpoints: []string{"anthropic"}, KeyEnv: "ANTHROPIC_AUTH_TOKEN", read: readClaude, session: initSession}
	a.build = func(in Request) (Launch, error) {
		args := []string{"-p"}
		if in.Session != "" {
			args = append(args, "--resume", in.Session)
		}
		args = append(args, "--output-format", "stream-json", "--verbose")
		if in.Live {
			args = append(args, "--input-format", "stream-json", "--replay-user-messages")
		}
		args = append(args, "--permission-mode", "bypassPermissions", "--setting-sources", "user,project", "--strict-mcp-config")
		config, err := json.Marshal(map[string]any{"mcpServers": map[string]any{"chrome-devtools": chromeMCP()}})
		if err != nil {
			return Launch{}, err
		}
		args = append(args, "--mcp-config", string(config))
		if in.Model != "" {
			args = append(args, "--model", in.Model)
		}
		if in.Effort != "" {
			args = append(args, "--effort", in.Effort)
		}
		l := Launch{Exe: a.Exe, Args: args, Dir: in.Dir, StdinFile: in.PromptFile, Live: in.Live}
		if in.Endpoint != nil {
			l.Env = map[string]string{"ANTHROPIC_BASE_URL": in.Endpoint.BaseURL}
		}
		return l, nil
	}
	return a
}

// codex exec：--json 逐行输出事件；-C 工作目录、-m 模型、强度走 -c model_reasoning_effort；PROMPT 写 - 从标准输入读。
// --skip-git-repo-check：没有仓库的任务（work/、工作地点、审阅）目录不是 git 仓库，不带 codex 直接拒绝启动。
// --ignore-user-config：不读用户个人的 config.toml（模型、强度、MCP、hooks、memories），登录照用；没写模型时用 CLI 自带的缺省（最新）。
// 本机装了 computer use 时再用 -c 把那几张表带上（in.ComputerUse，见 computeruse.go）。
// --dangerously-bypass-approvals-and-sandbox：不开沙箱、不问审批，computer use 的逐应用授权也由它放行。
// 继续：codex exec resume --json <会话> -（没有 -C）；会话 id 是 thread.started 的 thread_id。
func codexAdapter() *Driver {
	a := &Driver{Tool: "codex", Exe: "codex", Efforts: []string{"minimal", "low", "medium", "high", "xhigh"},
		Tell: TellResume, JSON: true, Endpoints: []string{"responses"}, read: readCodex, session: regexp.MustCompile(`"type":"thread.started","thread_id":"([0-9a-f-]{36})"`)}
	a.build = func(in Request) (Launch, error) {
		var args []string
		if in.Session != "" {
			args = []string{"exec", "resume", "--json", "--skip-git-repo-check", "--ignore-user-config", "--dangerously-bypass-approvals-and-sandbox"}
		} else {
			args = []string{"exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--dangerously-bypass-approvals-and-sandbox", "-C", in.Dir}
		}
		args = append(args, "--disable", "apps")
		overrides, err := codexMCPOverrides(in.ComputerUse)
		if err != nil {
			return Launch{}, err
		}
		for _, kv := range overrides {
			args = append(args, "-c", kv)
		}
		if in.Model != "" {
			args = append(args, "-m", in.Model)
		}
		if in.Effort != "" {
			args = append(args, "-c", fmt.Sprintf("model_reasoning_effort=%q", in.Effort))
		}
		if e := in.Endpoint; e != nil {
			set := func(k, v string) { args = append(args, "-c", fmt.Sprintf("model_providers.atrium.%s=%q", k, v)) }
			args = append(args, "-c", `model_provider="atrium"`)
			set("name", "Atrium 自定义端点")
			set("base_url", e.BaseURL)
			set("wire_api", "responses")
			if e.KeyEnv != "" {
				set("env_key", e.KeyEnv)
			}
		}
		if in.Session != "" {
			args = append(args, in.Session)
		}
		args = append(args, "-")
		return Launch{Exe: a.Exe, Args: args, Dir: in.Dir, StdinFile: in.PromptFile}, nil
	}
	return a
}

var cursorEfforts = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}

// CursorModel：强度写进模型名后缀，插在 -fast 之前（gpt-5.3-codex + high → gpt-5.3-codex-high）。纯函数。
func CursorModel(model, effort string) (string, error) {
	if effort == "" {
		return model, nil
	}
	if model == "auto" {
		return "", api.Usage("cursor 的 auto 由 Cursor 自己挑模型，不能指定思考强度；写具体模型，如 cursor+gpt-5.3-codex:high")
	}
	base, fast := strings.CutSuffix(model, "-fast")
	for _, e := range cursorEfforts {
		if strings.HasSuffix(base, "-"+e) {
			return "", api.Usage("cursor 的模型名 %s 已带强度 %s，不要再写 :%s", model, e, effort)
		}
	}
	out := base + "-" + effort
	if fast {
		out += "-fast"
	}
	return out, nil
}

// cursor-agent -p：提示词读标准输入；stream-json 事件；--force --trust --sandbox disabled 全放行。继续 --resume。
// 缺省模型 auto 由 Cursor 自己挑（跟随）。
func cursorAdapter() *Driver {
	a := &Driver{Tool: "cursor", Exe: "cursor-agent", DefaultModel: "auto", Efforts: cursorEfforts, Tell: TellResume, JSON: true,
		read: readCursor, session: initSession}
	a.build = func(in Request) (Launch, error) {
		model := in.Model
		if model == "" {
			model = a.DefaultModel
		}
		model, err := CursorModel(model, in.Effort)
		if err != nil {
			return Launch{}, err
		}
		args := []string{"-p"}
		if in.Session != "" {
			args = append(args, "--resume", in.Session)
		}
		args = append(args, "--output-format", "stream-json", "--force", "--trust", "--sandbox", "disabled",
			"--workspace", in.Dir, "--model", model)
		return Launch{Exe: a.Exe, Args: args, Dir: in.Dir, StdinFile: in.PromptFile}, nil
	}
	return a
}

var agyBuiltInEffort = regexp.MustCompile(`-(low|medium|high)$`)

// AgyModelArgs：模型名带强度的只传 --model；claude-*、gpt-oss-* 不接受 --effort；其余照传。纯函数。
func AgyModelArgs(model, effort string) ([]string, error) {
	if model == "" {
		if effort != "" {
			return nil, api.Usage("agy 写思考强度时须同时写模型，如 agy+gemini-3.8-flash:high")
		}
		return nil, nil
	}
	if effort == "" {
		return []string{"--model", model}, nil
	}
	if m := agyBuiltInEffort.FindStringSubmatch(model); m != nil {
		if m[1] == effort {
			return []string{"--model", model}, nil
		}
		return nil, api.Usage("agy 的模型 %s 已带强度 %s，与 :%s 冲突", model, m[1], effort)
	}
	if strings.HasPrefix(model, "claude-") || strings.HasPrefix(model, "gpt-oss-") {
		return nil, api.Usage("agy 的 %s 不接受思考强度（强度含在模型里），去掉 :%s", model, effort)
	}
	return []string{"--model", model, "--effort", effort}, nil
}

// agy（Antigravity）：stream-json 从标准输入读一条 user 事件，输出同格式事件。
// 缺省模型写死：agy models 只列清单、不标哪个是缺省；模型名要带强度（gemini-3.8-flash 会被拒）。
func agyAdapter() *Driver {
	a := &Driver{Tool: "agy", Exe: "agy", DefaultModel: "gemini-3.8-flash-high", Efforts: []string{"low", "medium", "high", "max"},
		Tell: TellRestart, JSON: true, read: readAgy}
	a.build = func(in Request) (Launch, error) {
		m, err := AgyModelArgs(in.Model, in.Effort)
		if err != nil {
			return Launch{}, err
		}
		args := append([]string{"--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions",
			"--disable-slash-commands"}, m...)
		msg, _ := json.Marshal(map[string]any{"event": "user", "message": map[string]string{"content": in.Prompt}})
		return Launch{Exe: a.Exe, Args: args, Dir: in.Dir, StdinData: string(msg) + "\n"}, nil
	}
	return a
}

// kimi -p：非交互单次运行。CLI 2.1.1 只接受参数提示词，让它读取任务文件，避免把正文放入命令行。
func kimiAdapter() *Driver {
	a := &Driver{Tool: "kimi", Exe: "kimi", Tell: TellRestart}
	a.build = func(in Request) (Launch, error) {
		args := []string{"-p", "请先完整读取任务说明文件 " + in.PromptFile + "，然后按文件内容执行。"}
		if in.Model != "" {
			args = append(args, "-m", in.Model)
		}
		return Launch{Exe: a.Exe, Args: args, Dir: in.Dir}, nil
	}
	return a
}

// grok --prompt-file：单轮提示词从文件读，--always-approve、--cwd、--reasoning-effort；没写模型用服务端缺省。
func grokAdapter() *Driver {
	a := &Driver{Tool: "grok", Exe: "grok", Efforts: []string{"low", "medium", "high"},
		Tell: TellRestart, JSON: true, read: readGrok}
	a.build = func(in Request) (Launch, error) {
		args := []string{"--prompt-file", in.PromptFile, "--output-format", "streaming-messages-json"}
		if in.Model != "" {
			args = append(args, "-m", in.Model)
		}
		if in.Effort != "" {
			args = append(args, "--reasoning-effort", in.Effort)
		}
		args = append(args, "--always-approve", "--cwd", in.Dir)
		return Launch{Exe: a.Exe, Args: args, Dir: in.Dir}, nil
	}
	return a
}

// Spec 给远程代理：按请求算出进程调用并按子进程环境找程序（代理那台没有档案库，通用命令行执行者的写法随 req.CLI 带来）。
// 走标准输入的提示词直接从 req.Prompt 给，不要求那台有提示词文件。
func (a *Driver) Spec(req Request, env map[string]string) (platform.Spec, error) {
	if req.PromptFile == "" {
		// 通用命令行执行者可能用 {prompt_file}：写在临时目录，不进工作树（免得被执行者提交）。
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
	req.Live = false
	req, err := LocalTools(a.Tool, req)
	if err != nil {
		return platform.Spec{}, err
	}
	l, err := Build(a.Tool, req)
	if err != nil {
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
