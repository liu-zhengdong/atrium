package quota

import (
	"context"
	"net/http"
	"time"
)

// Window 是一个额度窗口（会话、周、月、模型专属……），只收百分比口径。
type Window struct {
	ID       string  `json:"id"`
	Label    string  `json:"label"`
	Used     float64 `json:"used"`      // 0–100
	ResetsAt int64   `json:"resets_at"` // 毫秒；0 为不知道
	Period   int64   `json:"period"`    // 秒；0 为不知道或不按固定周期
}

// Reading 是一台机器对一个账号的一次读数。只含数字、套餐名与来源指纹，不含令牌；Account 是 provider 类别。
type Reading struct {
	Account string   `json:"account"`
	OK      bool     `json:"ok"`
	Reason  string   `json:"reason,omitempty"` // 读不到的原因（固定中文句子，不带令牌或响应正文）
	Plan    string   `json:"plan,omitempty"`
	Windows []Window `json:"windows,omitempty"`
	ReadAt  int64    `json:"read_at"`
	Finger  string   `json:"finger,omitempty"` // 来源指纹
	// Plans 只有 magpie 读数有（Account 为 MagpieAccount）：它一次给全部套餐。
	Plans   []MagpiePlan `json:"plans,omitempty"`
	retryAt int64
}

// Deps 是读取器用到的外部依赖；测试全部换成假的。
type Deps struct {
	GOOS string
	Home string
	Env  map[string]string
	HTTP *http.Client
	Now  func() time.Time
	// URLs 覆盖用量接口地址；键为账号。magpie 只从这里取（LocalDeps 填），没填就不读 magpie。
	URLs map[string]string
}

func (d Deps) url(account string) string { return d.URLs[account] }

// ReadAccount 读一个账号的额度；目前只有 magpie 有自带读取。
func ReadAccount(ctx context.Context, d Deps, account string) Reading {
	var r Reading
	if account == MagpieAccount {
		r = readMagpie(ctx, d)
	} else {
		r = Reading{Reason: "没有自带读取"}
	}
	r.Account = account
	r.ReadAt = d.Now().UnixMilli()
	return r
}

func fail(reason string) Reading { return Reading{Reason: reason} }

// LocalDeps 是真实的依赖：网络与 magpie 地址。
func LocalDeps(goos, home string, env map[string]string) Deps {
	return Deps{
		GOOS: goos, Home: home, Env: env,
		HTTP: &http.Client{},
		Now:  time.Now,
		URLs: map[string]string{MagpieAccount: magpieURL(env)},
	}
}
