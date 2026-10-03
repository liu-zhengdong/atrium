// Package quota 是额度：自带读取 Claude Code、Codex、OpenCode Go 的用量（读本机已登录凭据调供应商用量接口，只读），
// 其余账号本机有 OpenQuota 就用 `openquota pace --json` 补；远程机器上报的读数按机器/provider 保留。
// 读取只在服务的后台循环里做（loop），读数存 quota_cache；分派任务、网页、命令都只取存下的读数（Last）。给用户留的份额（缺省 20%）扣掉后才算富余。「工具+模型@机器」撞了额度的标记在 workers。
//
// Spares/Last 仅展示摘要，不作跨机器选择依据。给 hosts：Local（代理读本机）、Record（服务收远程读数）。
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

// Local 是一台机器上自带读取的到期表：到期才真去请求。只由一个后台循环调用（服务的 loop 或代理的上报）。
type Local struct {
	deps Deps
	next map[string]time.Time
}

func NewLocal(d Deps) *Local { return &Local{deps: d, next: map[string]time.Time{}} }

// Due 读到期的账号并返回这些新读数（没到期的不读、不返回）。
func (l *Local) Due(ctx context.Context, disabled map[string]bool) []Reading {
	now := l.deps.Now()
	var due []string
	for _, a := range Builtin {
		if disabled[a] {
			delete(l.next, a)
			continue
		}
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

// keyOf 按机器×provider 保留成功和最近失败；Finger 是来源线索，不作主键。
func keyOf(host string, r Reading) string {
	key := host + ":" + r.Account
	if !r.OK {
		key += ":fail"
	}
	return key
}

// CacheRows 是既有缓存的有界预算：每机器×provider 最多成功/失败两行。
// 最多 250 对来源同时保留两行；达到 500 行明确报错，不能静默 LIMIT 截断。
const CacheRows = 500

// Record 正常刷新替换该机器/provider 的成功事实并清旧行；失败另记，
// 不改原成功 Finger/ReadAt。旧指纹主键只随实际正常刷新清理，不能复原已丢机器。
func Record(ctx context.Context, db *store.DB, host string, readings []Reading) error {
	return db.Tx(ctx, func(tx *sql.Tx) error {
		for _, r := range readings {
			if !isAccount(r.Account) {
				return api.Usage("不认识的额度来源 %q", r.Account)
			}
			key := keyOf(host, r)
			if r.OK {
				if _, err := tx.ExecContext(ctx, `DELETE FROM quota_cache WHERE tool = ? AND account != ?
      AND json_extract(body, '$.host') = ?`, r.Account, key, host); err != nil {
					return err
				}
			}
			body, err := json.Marshal(Stored{Host: host, Reading: r})
			if err != nil {
				return fmt.Errorf("额度来源无法编码：%w", err)
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO quota_cache (account, tool, body, read_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (account) DO UPDATE SET tool = excluded.tool, body = excluded.body, read_at = excluded.read_at`,
				key, r.Account, string(body), r.ReadAt); err != nil {
				return err
			}
		}
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM quota_cache WHERE account != ?`, oqKey).Scan(&count); err != nil {
			return err
		}
		if count > CacheRows {
			return fmt.Errorf("额度缓存 %d/%d 行超限（机器×provider，每对最多成功/失败两行）；先移除不用的来源", count, CacheRows)
		}
		return nil
	})
}

// DropHost 随既有机器删除清理该机器的来源，无独立关联状态。
func DropHost(ctx context.Context, q store.Querier, host string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM quota_cache WHERE account != ? AND json_extract(body, '$.host') = ?`, oqKey, host)
	return err
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
	rows, err := q.QueryContext(ctx, `SELECT body FROM quota_cache WHERE account != ? ORDER BY read_at DESC LIMIT ?`, oqKey, CacheRows+1)
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
		if len(out) > CacheRows {
			return nil, fmt.Errorf("额度缓存超过 %d 行，未返回截断结果", CacheRows)
		}
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

// ---- 后台读取 ----

// oqKey 是 quota_cache 里 OpenQuota 那一行的键（account 与 tool 都是它）：存最近一次 `openquota pace --json` 的全部行。
const oqKey = "openquota"

// oqStored 是 OpenQuota 那一行的内容。
type oqStored struct {
	Rows  []Pace `json:"rows"`
	Error string `json:"error,omitempty"`
}

// poller 是服务的后台读取：本机自带读取到期就读（到期由 Local 管），OpenQuota 每 okTTL 跑一次，读数都存进 quota_cache。
// 分派任务、网页、命令只取存下的读数（Last），不等读取。
type poller struct {
	local *Local
	oq    func(context.Context) ([]Pace, error)
	now   func() time.Time
	oqAt  time.Time
}

// round 读一轮到期的并存下。
func (p *poller) round(ctx context.Context, db *store.DB) error {
	disabled, err := Disabled(ctx, db)
	if err != nil {
		return err
	}
	if r := p.local.Due(ctx, disabled); len(r) > 0 {
		if err := Record(ctx, db, LocalHost, r); err != nil {
			return err
		}
	}
	now := p.now()
	if now.Sub(p.oqAt) < okTTL {
		return nil
	}
	p.oqAt = now
	rows, err := p.oq(ctx)
	st := oqStored{Rows: rows}
	if err != nil {
		previous, readErr := openquotaStored(ctx, db)
		if readErr != nil {
			return readErr
		}
		st.Rows = previous.Rows // 失败不换原成功来源或 refreshedAt。
		st.Error = err.Error()
	}
	body, _ := json.Marshal(st)
	_, err = db.ExecContext(ctx, `INSERT INTO quota_cache (account, tool, body, read_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (account) DO UPDATE SET body = excluded.body, read_at = excluded.read_at`, oqKey, oqKey, string(body), now.UnixMilli())
	return err
}

// poll 每分钟读一轮，ctx 取消时返回。
func poll(ctx context.Context, db *store.DB, p *poller) error {
	for {
		if err := p.round(ctx, db); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Minute):
		}
	}
}

// loop 是服务的后台循环。隔离实例（config.Paths.Isolated）不读本机：不碰开发者的登录、钥匙串与 OpenQuota，只摆存下的读数。
func loop(ctx context.Context, env *app.Env) error {
	if env.Paths.Isolated() {
		return nil
	}
	home, _ := os.UserHomeDir()
	osEnv := platform.EnvMap(os.Environ())
	return poll(ctx, env.DB, &poller{
		local: NewLocal(LocalDeps(runtime.GOOS, home, osEnv)),
		oq:    func(ctx context.Context) ([]Pace, error) { return readOpenquota(ctx, osEnv) },
		now:   time.Now,
	})
}

func openquotaStored(ctx context.Context, q store.Querier) (oqStored, error) {
	var body string
	err := q.QueryRowContext(ctx, `SELECT body FROM quota_cache WHERE account = ?`, oqKey).Scan(&body)
	if store.IsNotFound(err) {
		return oqStored{}, nil
	}
	if err != nil {
		return oqStored{}, err
	}
	var st oqStored
	if err := json.Unmarshal([]byte(body), &st); err != nil {
		return oqStored{}, fmt.Errorf("quota_cache 的 OpenQuota 行坏了：%w", err)
	}
	return st, nil
}

// ---- 读一览 ----

// Overview 是 quota 一览。
type Overview struct {
	Lines   []Line   `json:"lines"`
	Reserve int      `json:"reserve"`
	Notes   []string `json:"notes"`
}

// Last 是存下的读数的一览：不去读，马上返回（读取由后台循环做）。
func Last(ctx context.Context, env *app.Env) (Overview, error) {
	disabled, err := Disabled(ctx, env.DB)
	if err != nil {
		return Overview{}, err
	}
	all, err := stored(ctx, env.DB)
	if err != nil {
		return Overview{}, err
	}
	oq, err := openquotaStored(ctx, env.DB)
	if err != nil {
		return Overview{}, err
	}
	reserve, err := Reserve(ctx, env.DB)
	if err != nil {
		return Overview{}, err
	}
	ov := Overview{Reserve: reserve, Notes: []string{}}
	if oq.Error != "" {
		ov.Notes = append(ov.Notes, oq.Error)
	}
	if env.Paths.Isolated() {
		ov.Notes = append(ov.Notes, "隔离实例不读本机额度（自带读取与 OpenQuota）")
	}
	for _, line := range Lines(mergeHosts(all, LocalHost, store.Now()), agePaces(oq.Rows, store.Now())) {
		if !disabled[line.Account] {
			ov.Lines = append(ov.Lines, line)
		}
	}
	return ov, nil
}

// Spares 给分派任务：每个账号的富余（已扣给用户留的份额）。
func Spares(ctx context.Context, env *app.Env) (map[string]Spare, error) {
	ov, err := Last(ctx, env)
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

func Module() app.Module {
	return app.Module{Name: "quota", Commands: Commands, Routes: Routes, Run: loop}
}

type setBody struct {
	Reserve *int `json:"reserve,omitempty"`
}

func Routes(r *api.Router, env *app.Env) {
	r.Handle("GET /api/quota", func(q *api.Req) (any, error) { return Last(q.Context(), env) })
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
		return Last(ctx, env)
	})
}

func Commands(t *cli.Table) {
	t.Group("quota", "额度：各账号用量与给用户留的份额")
	t.Add(cli.Command{Path: "quota", Summary: "各账号额度与富余（撞了额度的「工具+模型@机器」见 atrium workers）",
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(0); err != nil {
				return err
			}
			var ov Overview
			if err := c.Call("GET", "/api/quota", nil, &ov); err != nil {
				return err
			}
			return c.Done(ov, Format(ov), "atrium workers")
		}})
	t.Add(cli.Command{Path: "quota set", Summary: "改额度设置（只有用户能改）",
		Flags: []cli.Flag{
			{Name: "reserve", Value: "百分比", Help: "给用户留的份额（缺省 20），分派任务扣掉后才算富余"},
		},
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(0); err != nil {
				return err
			}
			if !c.Has("reserve") {
				return api.Usage("--reserve: 必填")
			}
			n, err := c.Int("reserve", 0)
			if err != nil {
				return err
			}
			var ov Overview
			if err := c.Call("POST", "/api/quota", setBody{Reserve: &n}, &ov); err != nil {
				return err
			}
			return c.Done(ov, Format(ov), "atrium quota")
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
		if l.Plan != nil && *l.Plan != "" {
			fmt.Fprintf(&b, "  %s", *l.Plan)
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
