package workers

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
)

// dsh（DeepSeek Harness）的执行者形态是它的一次性 profile：`dsh --profile headless` 跑完一个任务就退出，
// 提示词走标准输入，--json 让标准输出成为逐行 JSON 事件（解析见 tracers.go 的 readDSH）。
// 审批与沙箱由 DSH 的同一个变量决定（dsh-user-approval 与 dsh-sandbox-policy 都读 DSH_PERMISSION_MODE）：
// danger-full-access 时审批是 never，缺省的 workspace-write 是 ask——没有应答方会卡在审批上，所以拉起时放行。
// 模型与思考强度经 --patch 写出的覆盖层给：base 层的 agent-default-model 只有 profile 一处，
// 而 patch 是整份替换它的 config，所以 provider 与 model 都要写全；不写就跟随 profile 自己的模型。
// 会话 id 是 session-<uuid>：Atrium 各处（会话校验、SessionOf）按裸 uuid 认，日志里取 uuid、拉起时加回前缀。
const (
	dshProfile   = "headless"
	dshPatchName = "dsh-model.yml"
)

// dshPatchFile 是这次拉起的模型覆盖层路径：与提示词同在任务目录（数据目录里），不落进工作树。
func dshPatchFile(in Request) string { return filepath.Join(filepath.Dir(in.PromptFile), dshPatchName) }

func dshAdapter() *Driver {
	a := &Driver{Tool: "dsh", Exe: "dsh", Efforts: []string{"off", "low", "high", "max"},
		Tell: TellResume, JSON: true, read: readDSH,
		session: regexp.MustCompile(`"sessionId":"session-([0-9a-f-]{36})"`)}
	a.build = func(in Request) (Launch, error) {
		l := Launch{Exe: a.Exe, Dir: in.Dir, Env: map[string]string{"DSH_PERMISSION_MODE": "danger-full-access"}}
		l.Args = []string{"--profile", dshProfile}
		if in.Model != "" {
			provider, model, ok := strings.Cut(in.Model, "/")
			if !ok || provider == "" || model == "" {
				return Launch{}, api.Usage("dsh 的模型要写 provider/模型（如 deepseek-official/deepseek-pro）：%s", in.Model)
			}
			path := dshPatchFile(in)
			l.Files = map[string]string{path: dshPatch(provider, model, in.Effort)}
			l.Args = append(l.Args, "--patch", path)
		} else if in.Effort != "" {
			return Launch{}, api.Usage("dsh 要写模型才能给思考强度：执行者写 dsh+provider/模型:%s", in.Effort)
		}
		l.Args = append(l.Args, "--json")
		if in.Session != "" {
			l.Args = append(l.Args, "--session-id", "session-"+in.Session)
		}
		l.Args = append(l.Args, "-")
		l.StdinFile = in.PromptFile
		return l, nil
	}
	return a
}

// dshPatch 写出模型覆盖层：agent-default-model 的 config 被整份替换，provider 与 model 必须都给。
func dshPatch(provider, model, effort string) string {
	s := fmt.Sprintf("- id: agent-default-model\n  config:\n    provider: %s\n    model: %s\n", provider, model)
	if effort != "" {
		s += "    reasoningEffort: " + effort + "\n"
	}
	return s
}
