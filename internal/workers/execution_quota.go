package workers

import (
	"context"
	"os"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/quota"
)

// ResolveExecution 是本轮解析/启动给组合挂额度绑定的入口（测试可替换）。只有经 magpie 的组合有绑定
// （MagpieBinding）；直连组合没有，额度按未知。绑定每次新建、不落库，随本轮解析失效。
var ResolveExecution = func(_ context.Context, _ *app.Env, r Resolved, host string) (Resolved, error) {
	r.QuotaBinding = MagpieBinding(r, host, quota.MagpieGateway(platform.EnvMap(os.Environ())))
	return r, nil
}

// ExecutionBinding 是本轮组合在某台机器上走的 magpie provider：这台机器的 magpie 读数里同名 provider 的套餐即它的额度。
type ExecutionBinding struct {
	Worker, Host, Provider string
}

// MagpieBinding 认出经 magpie 的组合（纯函数）：档案端点就是 magpie 网关（quota.ViaMagpie），
// 模型按 magpie 的路由名写成 <provider>/<模型>，provider 即第一段。其余返回 nil。
func MagpieBinding(r Resolved, host, gateway string) *ExecutionBinding {
	if !quota.ViaMagpie(r.Rules.Endpoint, gateway) {
		return nil
	}
	provider, model, ok := strings.Cut(r.CLIModel, "/")
	if !ok || provider == "" || model == "" {
		return nil
	}
	return &ExecutionBinding{Worker: r.ID, Host: host, Provider: provider}
}

func (b *ExecutionBinding) Valid(r Resolved, host string) bool {
	return b != nil && b.Worker == r.ID && b.Host == host && b.Provider != ""
}

// SamePool：同一台机器上经同一个 magpie provider——magpie 对它的账号出错即换，一个报额度用尽就是这台的全部用尽。
func SamePool(a, b *ExecutionBinding) bool {
	return a != nil && b != nil && a.Provider != "" && a.Host == b.Host && a.Provider == b.Provider
}

func (a Availability) checkBinding(r Resolved, host string, tokens int64) (quota.Spare, string) {
	if !r.QuotaBinding.Valid(r, host) {
		return quota.Spare{}, ""
	}
	sp, _ := quota.MagpieSpare(a.Readings, host, r.QuotaBinding.Provider, a.Reserve, a.Now)
	return sp.WithDemand(tokens), ""
}

// QuotaReset 是经 magpie 的组合额度用尽后最早能恢复的时刻（magpie 窗口的重置时间），未知为 0。
func (a Availability) QuotaReset(b *ExecutionBinding) int64 {
	if b == nil {
		return 0
	}
	_, at := quota.MagpieSpare(a.Readings, b.Host, b.Provider, a.Reserve, a.Now)
	return at
}
