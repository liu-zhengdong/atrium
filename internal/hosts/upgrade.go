package hosts

import (
	"bytes"
	"context"
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/release/selfupdate"
)

// catchUp 让代理跟服务同版本：代理旧于服务（判定同服务自升级，selfupdate.Upgrade）就下载同一版本的本平台二进制、
// 校验 SHA256SUMS 后替换自身，返回 ErrUpgraded 让 Run 退出、由系统服务按新二进制重起。
// 在跑的执行者不等：它们是 Detached 拉起的，代理退出照跑，新代理按 runs/ 里的运行记录接着看、hello 对账重新跟进。
// 隔离的代理（数据目录不是缺省的）与开发版不升；暂停（全局或这台）时不升。
// 同一版本升失败只报一次（服务发 online.failed 给秘书），本进程不再重试；没报上的下次连上再报。
func (a *Agent) catchUp(ctx context.Context, to, repo string, paused bool) error {
	def, err := AgentDir(func(string) string { return "" })
	if err != nil {
		return err
	}
	on, _ := selfupdate.SelfUpgrade(a.Dir, def, a.Version)
	if selfupdate.Upgrade(a.Version, to, on, paused, a.failed) {
		a.Log.Info("代理旧于服务，升级", "from", a.Version, "to", to)
		err := selfupdate.Install(ctx, a.gh(), repo, to, a.Exe)
		if err == nil {
			return fmt.Errorf("%w（%s → %s）", ErrUpgraded, a.Version, to)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		a.Log.Error("代理升级失败", "from", a.Version, "to", to, "err", err)
		a.failed = to
		a.failure = map[string]string{"from": a.Version, "to": to, "error": tail(err.Error(), 500)}
	}
	if a.failure != nil {
		if err := a.call(ctx, "/api/agent/upgrade-failed", a.failure, nil); err != nil {
			return err
		}
		a.failure = nil
	}
	return nil
}

func (a *Agent) gh() selfupdate.Runner {
	if a.GH != nil {
		return a.GH
	}
	return toolRunner{a}
}

// toolRunner 是代理的 selfupdate.Runner：用这台执行者的环境跑（执行者开 PR 用的就是这个 gh）。
type toolRunner struct{ a *Agent }

func (r toolRunner) Run(ctx context.Context, _ string, name string, args ...string) (string, error) {
	var out, errOut bytes.Buffer
	if err := r.a.runTool(ctx, name, args, &out, &errOut); err != nil {
		return "", fmt.Errorf("%s %s 失败：%v：%s", name, strings.Join(firstArgs(args, 3), " "), err, strings.TrimSpace(tail(errOut.String(), 500)))
	}
	return out.String(), nil
}
