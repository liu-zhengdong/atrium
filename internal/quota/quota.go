// Package quota 是额度：自带读取 Claude Code、Codex、OpenCode Go 的用量（读本机已登录凭据调供应商用量接口，只读），
// 其余账号本机有 OpenQuota 就用 `openquota pace --json` 补；远程机器上报的读数按账号指纹合并。
// 读数存 quota_cache；给用户留的份额（缺省 20%）扣掉后才算富余。「工具+模型@机器」撞了额度的标记在 workers。
//
// 给 dispatch：Spares(ctx, env) → 账号 → 富余。给 hosts：Local（代理读本机）、Record（服务收远程读数）。
package quota

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
)

const (
	okTTL      = 5 * time.Minute // 读到后多久再读
	failTTL    = time.Minute     // 读不到后多久再读（限流按 Retry-After 推迟）
	DefaultPct = 20              // 给用户留的份额缺省值
	LocalHost  = "h1"
)

func goos() string { return runtime.GOOS }

// Local 是一台机器上自带读取的缓存：到期才真去请求，同一时刻只有一轮在读。
type Local struct {
	deps Deps
	mu   sync.Mutex
	next map[string]time.Time
}

func NewLocal(d Deps) *Local { return &Local{deps: d, next: map[string]time.Time{}} }

// Enabled：ATRIUM_QUOTA_READERS=off 关掉自带读取（测试与冒烟用，免得读开发者本机登录）。
func Enabled(env map[string]string) bool {
	switch strings.ToLower(strings.TrimSpace(env["ATRIUM_QUOTA_READERS"])) {
	case "off", "0", "false":
		return false
	}
	return true
}

// Default 是这个进程的本机读取（按当前环境）；自带读取关掉时为 nil。
func Default() *Local {
	defaultOnce.Do(func() {
		env := platform.EnvMap(os.Environ())
		if !Enabled(env) {
			return
		}
		home, _ := os.UserHomeDir()
		defaultLocal = NewLocal(LocalDeps(runtime.GOOS, home, env))
	})
	return defaultLocal
}

var (
	defaultOnce  sync.Once
	defaultLocal *Local
)

// Due 读到期的账号并返回这些新读数（没到期的不读、不返回）。
func (l *Local) Due(ctx context.Context) []Reading {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.deps.Now()
	var due []string
	for _, a := range Builtin {
		if !now.Before(l.next[a]) {
			due = append(due, a)
		}
	}
	out := make([]Reading, len(due))
	var wg sync.WaitGroup
	for i, a := range due {
		wg.Go(func() { out[i] = ReadAccount(ctx, l.deps, a) })
	}
	wg.Wait()
	for _, r := range out {
		next := now.Add(okTTL)
		if !r.OK {
			next = now.Add(failTTL)
			if at := time.UnixMilli(r.retryAt); r.retryAt > 0 && at.After(next) {
				next = at
			}
		}
		l.next[r.Account] = next
	}
	return out
}

// ---- 存储 ----

func keyOf(host string, r Reading) string {
	switch {
	case !r.OK:
		return host + ":" + r.Account + ":fail"
	case r.Finger != "":
		return r.Finger
	}
	return host + ":" + r.Account
}

// Record 存一台机器的读数：读到的按账号指纹一行（多台同一账号合一行，取最新），同时清掉这台这个账号的旧行；
// 读不到的只记失败原因，不删上次读到的（沿用 6 小时）。
func Record(ctx context.Context, db *store.DB, host string, readings []Reading) error {
	return db.Tx(ctx, func(tx *sql.Tx) error {
		for _, r := range readings {
			if !isAccount(r.Account) {
				return api.Usage("不认识的额度账号 %q", r.Account)
			}
			key := keyOf(host, r)
			if r.OK {
				if _, err := tx.ExecContext(ctx, `DELETE FROM quota_cache WHERE tool = ? AND account != ?
					AND json_extract(body, '$.host') = ?`, r.Account, key, host); err != nil {
					return err
				}
			}
			body, _ := json.Marshal(Stored{Host: host, Reading: r})
			if _, err := tx.ExecContext(ctx, `INSERT INTO quota_cache (account, tool, body, read_at) VALUES (?, ?, ?, ?)
				ON CONFLICT (account) DO UPDATE SET tool = excluded.tool, body = excluded.body, read_at = excluded.read_at`,
				key, r.Account, string(body), r.ReadAt); err != nil {
				return err
			}
		}
		return nil
	})
}

func isAccount(a string) bool {
	for _, x := range Accounts {
		if x == a {
			return true
		}
	}
	return false
}

func stored(ctx context.Context, q store.Querier) ([]Stored, error) {
	rows, err := q.QueryContext(ctx, `SELECT body FROM quota_cache ORDER BY read_at DESC LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Stored
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			return nil, err
		}
		var s Stored
		if err := json.Unmarshal([]byte(body), &s); err != nil {
			return nil, fmt.Errorf("quota_cache 有坏行：%w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// Reserve 是给用户留的份额（百分比）。
func Reserve(ctx context.Context, q store.Querier) (int, error) {
	var v int
	err := q.QueryRowContext(ctx, `SELECT value FROM quota_settings WHERE name = 'reserve_percent'`).Scan(&v)
	if store.IsNotFound(err) {
		return DefaultPct, nil
	}
	return v, err
}

// ---- 读一览 ----

var oqCache struct {
	sync.Mutex
	at   time.Time
	rows []Pace
	err  error
}

func openquota(ctx context.Context) ([]Pace, error) {
	oqCache.Lock()
	defer oqCache.Unlock()
	if time.Since(oqCache.at) < okTTL {
		return oqCache.rows, oqCache.err
	}
	oqCache.rows, oqCache.err = readOpenquota(ctx, platform.EnvMap(os.Environ()))
	oqCache.at = time.Now()
	return oqCache.rows, oqCache.err
}

// 测试换成假的：不读开发者本机的登录与 OpenQuota。
var (
	localFn     = Default
	openquotaFn = openquota
)

// Overview 是 quota 一览。
type Overview struct {
	Lines   []Line   `json:"lines"`
	Reserve int      `json:"reserve"`
	Notes   []string `json:"notes"`
}

// Read 刷新本机到期的读数，合并各台与 OpenQuota，得出一览。
func Read(ctx context.Context, db *store.DB) (Overview, error) {
	if r := localFn().Due(ctx); len(r) > 0 {
		if err := Record(ctx, db, LocalHost, r); err != nil {
			return Overview{}, err
		}
	}
	all, err := stored(ctx, db)
	if err != nil {
		return Overview{}, err
	}
	reserve, err := Reserve(ctx, db)
	if err != nil {
		return Overview{}, err
	}
	ov := Overview{Reserve: reserve, Notes: []string{}}
	oq, err := openquotaFn(ctx)
	if err != nil {
		ov.Notes = append(ov.Notes, err.Error())
	}
	if localFn() == nil {
		ov.Notes = append(ov.Notes, "自带读取已关（ATRIUM_QUOTA_READERS=off）")
	}
	now := store.Now()
	ov.Lines = Lines(mergeHosts(all, LocalHost, now), oq)
	return ov, nil
}

// Spares 给派活：每个账号的富余（已扣给用户留的份额）。
func Spares(ctx context.Context, env *app.Env) (map[string]Spare, error) {
	ov, err := Read(ctx, env.DB)
	if err != nil {
		return nil, err
	}
	out := map[string]Spare{}
	for _, l := range ov.Lines {
		out[l.Account] = SpareOf(l, ov.Reserve)
	}
	return out, nil
}

// ---- 接入 ----

func Module() app.Module { return app.Module{Name: "quota", Commands: Commands, Routes: Routes} }

type setBody struct {
	Reserve *int `json:"reserve,omitempty"`
}

func Routes(r *api.Router, env *app.Env) {
	r.Handle("GET /api/quota", func(q *api.Req) (any, error) { return Read(q.Context(), env.DB) })
	r.Handle("POST /api/quota", func(q *api.Req) (any, error) {
		if q.Actor.Kind != "user" {
			return nil, api.Forbidden("只有用户能改额度设置")
		}
		var b setBody
		if err := q.Decode(&b); err != nil {
			return nil, err
		}
		ctx := q.Context()
		if b.Reserve != nil {
			if *b.Reserve < 0 || *b.Reserve > 90 {
				return nil, api.Usage("--reserve: 应为 0 到 90 的整数，收到 %d", *b.Reserve)
			}
			if _, err := env.DB.ExecContext(ctx, `INSERT INTO quota_settings (name, value) VALUES ('reserve_percent', ?)
				ON CONFLICT (name) DO UPDATE SET value = excluded.value`, *b.Reserve); err != nil {
				return nil, err
			}
		}
		return Read(ctx, env.DB)
	})
}

func Commands(t *cli.Table) {
	t.Add(cli.Command{Path: "quota", Summary: "各账号额度与富余（撞了额度的「工具+模型@机器」见 atrium workers）",
		Flags: []cli.Flag{
			{Name: "reserve", Value: "百分比", Help: "给用户留的份额（缺省 20），派活扣掉后才算富余"},
		},
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(0); err != nil {
				return err
			}
			var ov Overview
			if c.Has("reserve") {
				n, err := c.Int("reserve", 0)
				if err != nil {
					return err
				}
				b := setBody{Reserve: &n}
				if err := c.Call("POST", "/api/quota", b, &ov); err != nil {
					return err
				}
			} else if err := c.Call("GET", "/api/quota", nil, &ov); err != nil {
				return err
			}
			return c.Done(ov, Format(ov), "atrium workers")
		}})
}

// Format 是 quota 的人读输出：有数据的一行一个账号，没有数据的汇成一行。
func Format(ov Overview) string {
	var b strings.Builder
	fmt.Fprintf(&b, "给用户留 %d%%；富余 = 周期已过 − 已用\n", ov.Reserve)
	pct := func(p *float64) string {
		if p == nil {
			return "—"
		}
		return fmt.Sprintf("%.1f%%", *p)
	}
	var none []string // 没有额度数据的账号，汇成一行
	for _, l := range ov.Lines {
		if l.UsedPercent == nil {
			if l.Note != "" {
				none = append(none, l.Account+"（"+l.Note+"）")
			} else {
				none = append(none, l.Account)
			}
			continue
		}
		fmt.Fprintf(&b, "%-12s", l.Account)
		fmt.Fprintf(&b, "已用 %s  富余 %s  短窗 %s", pct(l.UsedPercent), pct(l.SparePercent), pct(l.ShortUsedPct))
		if l.Plan != "" {
			fmt.Fprintf(&b, "  %s", l.Plan)
		}
		if l.Stale {
			b.WriteString("  旧数")
		}
		if l.Source == "openquota" {
			b.WriteString("  来自 OpenQuota")
		}
		if l.Note != "" {
			fmt.Fprintf(&b, "  （%s）", l.Note)
		}
		b.WriteString("\n")
	}
	if len(none) > 0 {
		fmt.Fprintf(&b, "没有额度数据：%s\n", strings.Join(none, "、"))
	}
	for _, n := range ov.Notes {
		fmt.Fprintf(&b, "提示：%s\n", n)
	}
	return b.String()
}
