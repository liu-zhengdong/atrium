package quota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// magpie 是额度感知的唯一来源（共识 m168 §2.2）：网关 GET /v1/magpie/quotas 与 `magpie quota --json` 同一份，
// 每个套餐（provider × 账号）一组窗口的已用百分比与重置时间。只喂派活避让与额度失败的恢复时刻，不算钱、不进展示。
// 每台机器读自己能连到的 magpie（缺省本机 127.0.0.1:3425，ATRIUM_MAGPIE_URL 可改），读数按机器存；读不到的机器额度未知。

// MagpieAccount 是 magpie 读数在 quota_cache 里的来源名；不在 Accounts 里，不进 quota 一览。
const MagpieAccount = "magpie"

// MagpieURL 是 magpie 网关的缺省地址（它缺省只听本机回环）。
const MagpieURL = "http://127.0.0.1:3425"

const magpiePath = "/v1/magpie/quotas"

// 一次读数的上限：套餐数与每个套餐的窗口数，超了整份拒绝，不截断。
const (
	magpiePlans   = 64
	magpieWindows = 64
	magpieBytes   = 1 << 20
)

// MagpiePlan 是 magpie 一个套餐的窗口读数。Provider 与 magpie 路由模型名的第一段相同（zcode/GLM-5.3 的 zcode）。
// 不存账号名与余额：判定只要窗口。
type MagpiePlan struct {
	Provider string   `json:"provider"`
	Plan     string   `json:"plan,omitempty"`
	Windows  []Window `json:"windows"`
}

// MagpieGateway 是 magpie 网关根地址：ATRIUM_MAGPIE_URL，没设就是缺省地址。
func MagpieGateway(env map[string]string) string {
	if base := strings.TrimSpace(env["ATRIUM_MAGPIE_URL"]); base != "" {
		return base
	}
	return MagpieURL
}

func magpieURL(env map[string]string) string {
	return strings.TrimSuffix(MagpieGateway(env), "/") + magpiePath
}

// ViaMagpie 判档案端点是不是这个 magpie 网关（纯函数）：协议、主机、端口都相同，路径不管（端点带 /v1）；
// localhost 与 127.0.0.1 算同一个地址。
func ViaMagpie(endpoint, gateway string) bool {
	a, err1 := url.Parse(strings.TrimSpace(endpoint))
	b, err2 := url.Parse(strings.TrimSpace(gateway))
	if endpoint == "" || err1 != nil || err2 != nil || a.Host == "" {
		return false
	}
	return a.Scheme == b.Scheme && hostKey(a) == hostKey(b)
}

func hostKey(u *url.URL) string {
	host, port := u.Hostname(), u.Port()
	if host == "localhost" {
		host = "127.0.0.1"
	}
	if port == "" {
		port = map[string]string{"http": "80", "https": "443"}[u.Scheme]
	}
	return net.JoinHostPort(host, port)
}

// readMagpie 读一次 magpie 额度。失败只给固定句子，不外传响应正文。
func readMagpie(ctx context.Context, d Deps) Reading {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second) // magpie 自己问厂商最多 12 秒
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", d.url(MagpieAccount), nil)
	if err != nil {
		return fail("magpie 地址写得不对")
	}
	hc := d.HTTP
	if hc == nil {
		hc = &http.Client{}
	}
	client := *hc
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("不跟随跳转") }
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return fail("magpie 额度接口超时")
		}
		return fail("连不上 magpie 额度接口")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fail(fmt.Sprintf("magpie 额度接口回 HTTP %d", resp.StatusCode))
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, magpieBytes+1))
	if err != nil {
		return fail("magpie 额度接口没读完")
	}
	if len(raw) > magpieBytes {
		return fail("magpie 额度回复超过 1 MiB，未接受")
	}
	plans, err := MagpiePlans(raw)
	if err != nil {
		return fail(err.Error())
	}
	return Reading{OK: true, Plans: plans}
}

type magpieSpan struct {
	Unlimited bool       `json:"unlimited"`
	Name      string     `json:"name"`
	Used      *float64   `json:"used"`
	ResetsAt  *time.Time `json:"resetsAt"`
}

type magpieQuota struct {
	Provider string       `json:"provider"`
	Kind     string       `json:"kind"`
	Plan     string       `json:"plan"`
	Windows  []magpieSpan `json:"windows"`
	Error    string       `json:"error"`
}

// MagpiePlans 解析网关回复 {"object":"list","data":[…]} 或命令行的数组（纯函数），折成窗口。
// 余额类、报错的套餐与不限量窗口不收（没有将满可言）；字段坏了或超限整份拒绝。
func MagpiePlans(raw []byte) ([]MagpiePlan, error) {
	bad := errors.New("magpie 额度回复字段损坏或超限，未接受部分结果")
	var list []magpieQuota
	if strings.HasPrefix(strings.TrimSpace(string(raw)), "[") {
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, bad
		}
	} else {
		var env struct {
			Data *[]magpieQuota `json:"data"`
		}
		if err := json.Unmarshal(raw, &env); err != nil || env.Data == nil {
			return nil, bad
		}
		list = *env.Data
	}
	if len(list) > magpiePlans {
		return nil, bad
	}
	out := []MagpiePlan{}
	for _, q := range list {
		if q.Provider == "" || len(q.Windows) > magpieWindows {
			return nil, bad
		}
		if q.Kind == "balance" || q.Error != "" {
			continue
		}
		p := MagpiePlan{Provider: q.Provider, Plan: q.Plan, Windows: []Window{}}
		for _, s := range q.Windows {
			if s.Name == "" || s.Used == nil || math.IsNaN(*s.Used) || math.IsInf(*s.Used, 0) || *s.Used < 0 {
				return nil, bad
			}
			if s.Unlimited {
				continue
			}
			w := Window{ID: s.Name, Label: s.Name, Used: clampPct(*s.Used)}
			if s.ResetsAt != nil {
				w.ResetsAt = s.ResetsAt.UnixMilli()
			}
			p.Windows = append(p.Windows, w)
		}
		if len(p.Windows) > 0 {
			out = append(out, p)
		}
	}
	return out, nil
}

// MagpieSpare 判一台机器上经 magpie 某 provider 的组合能不能派（纯函数）。
// 只认这台机器自己的、10 分钟内的成功读数；没有就是未知（零值、Account 为空）。
// magpie 对同一 provider 的多个账号出错即换，所以全部账号都有窗口将满才不派；
// 重置时刻已过的窗口不再算将满。resetAt 是最早能恢复的时刻（某个账号的将满窗口全部重置），给额度失败定恢复用，未知为 0。
func MagpieSpare(rows []Stored, host, provider string, reserve int, now int64) (sp Spare, resetAt int64) {
	var reading *Reading
	for i := range rows {
		r := &rows[i]
		if r.Host == host && r.Account == MagpieAccount && r.OK && r.ReadAt <= now && now-r.ReadAt < staleAfter {
			reading = &r.Reading
			break
		}
	}
	if reading == nil {
		return Spare{}, 0
	}
	limit := 100 - float64(reserve)
	var stops []string
	plans := 0
	for _, p := range reading.Plans {
		if p.Provider != provider {
			continue
		}
		plans++
		var full []string
		var until int64
		known := true
		for _, w := range p.Windows {
			if w.Used < limit || (w.ResetsAt != 0 && w.ResetsAt <= now) {
				continue
			}
			full = append(full, fmt.Sprintf("%s 已用 %.1f%%", w.ID, w.Used))
			if w.ResetsAt == 0 {
				known = false
			}
			until = max(until, w.ResetsAt)
		}
		if len(full) == 0 {
			return Spare{Account: MagpieAccount + "/" + provider}, 0
		}
		name := provider
		if p.Plan != "" {
			name += " " + p.Plan
		}
		stops = append(stops, name+"："+strings.Join(full, "、"))
		if known && (resetAt == 0 || until < resetAt) {
			resetAt = until
		}
	}
	if plans == 0 {
		return Spare{}, 0
	}
	return Spare{Account: MagpieAccount + "/" + provider,
		Stop: fmt.Sprintf("额度将满（magpie %s），须给用户留 %d%%", strings.Join(stops, "；"), reserve)}, resetAt
}
