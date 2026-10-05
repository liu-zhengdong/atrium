package quota

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// m146 actual-json.json 是来源提交的合成实际 CLI 输出，不含真实账号。
//
//go:embed testdata/pace-m146.json
var sourceFixture []byte

// legacyFixture 是 OpenQuota 0.8.5 的扁平 pace 出口实样（脱敏），没有 m146 契约的
// quotas/valueMetrics 等字段；校验必须拒绝并写明缺哪个字段，不说笼统「损坏」。
//
//go:embed testdata/pace-legacy.json
var legacyFixture []byte

func fixtureSources(t *testing.T) []Pace {
	t.Helper()
	var rows []Pace
	if err := json.Unmarshal(sourceFixture, &rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

func TestSourceContract(t *testing.T) {
	rows := fixtureSources(t)
	if err := validateSources(rows); err != nil {
		t.Fatal(err)
	}
	if len(rows[0].Quotas) != 2 || *rows[0].Quotas[0].UsedPercent != 25.123456789 || *rows[0].Quotas[1].UsedPercent != 100 {
		t.Fatal("遗漏月耗尽或精度", rows)
	}
	for _, tc := range []struct {
		name   string
		change func(*Pace)
	}{
		{"count", func(p *Pace) { p.Quotas[0].Format = "count" }},
		{"dollars", func(p *Pace) { p.Quotas[0].Format = "dollars"; s := "USD"; p.Quotas[0].Unit = &s }},
		{"未知单位", func(p *Pace) { p.Quotas[0].Unit = nil }},
		{"免费0与null", func(p *Pace) {
			p.Plan = nil
			p.Quotas[0].RemainingValue = ptr(0)
			p.ValueMetrics = []json.RawMessage{json.RawMessage(`{"id":"free","label":"free","values":[{"number":0,"kind":"count","estimated":false}],"expiriesAt":[]}`)}
			p.ValueMetricCount = 1
		}},
		{"匹配旧账号", func(p *Pace) {
			p.AccountIdentity = &AccountIdentity{Kind: "accountHash", Value: "synthetic-A", Source: "synthetic boundary"}
			p.CacheIdentityMatch = "mismatched"
			p.Remembered = true
		}},
		{"匹配未知", func(p *Pace) { p.CacheIdentityMatch = "unknown" }},
		{"reset未知", func(p *Pace) { p.Quotas[0].ResetsAt = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := fixtureSources(t)[0]
			tc.change(&p)
			if err := validateSources([]Pace{p}); err != nil {
				t.Fatal(err)
			}
			b, err := json.Marshal(p)
			if err != nil {
				t.Fatal(err)
			}
			var got Pace
			if err := json.Unmarshal(b, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(p, got) {
				t.Fatal("缓存往返丢事实")
			}
		})
	}
	t.Log("预期月100/周25原精度、count/dollars/未知单位、免费0/null、旧账号/mismatched、unknown与未知reset往返不变；实际符合，未判为token容量或当前组合额度")
}

func TestSourceRejectDamaged(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*Pace)
	}{
		{"遗漏窗口计数", func(p *Pace) { p.QuotaCount = 1 }},
		{"matched无身份", func(p *Pace) { p.CacheIdentityMatch = "matched" }},
		{"空单位", func(p *Pace) { s := ""; p.Quotas[0].Unit = &s }},
		{"坏百分比", func(p *Pace) { p.Quotas[0].UsedPercent = ptr(101) }},
		{"缺失百分比不是零", func(p *Pace) { p.Quotas[0].UsedPercent = nil }},
		{"未知质量", func(p *Pace) { p.DataQuality = "success" }},
		{"共享范围引用不存在窗口", func(p *Pace) {
			p.SharedScope = &SharedScope{ID: "synthetic", Source: "synthetic", WindowIDs: []string{"absent"}}
		}},
		{"窗口超限", func(p *Pace) {
			for len(p.Quotas) <= 64 {
				p.Quotas = append(p.Quotas, p.Quotas[0])
			}
			p.QuotaCount = len(p.Quotas)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := fixtureSources(t)[0]
			tc.change(&p)
			if validateSources([]Pace{p}) == nil {
				t.Fatal("坏输入未拒绝")
			}
		})
	}
	rows := fixtureSources(t)
	if validateSources(append(rows, rows[0])) == nil {
		t.Fatal("重复来源未拒绝")
	}
	t.Log("预期损坏/超限/重复来源整轮拒绝，不接受部分结果；实际符合")
}

// TestSourceRejectNames 拒收原因写明来源与缺/坏字段（t938：旧版出口曾只报「字段损坏或超限」）。
func TestSourceRejectNames(t *testing.T) {
	var legacy []Pace
	if err := json.Unmarshal(legacyFixture, &legacy); err != nil {
		t.Fatal(err)
	}
	err := validateSources(legacy)
	if err == nil || !strings.Contains(err.Error(), "缺 quotas/valueMetrics 数组") ||
		!strings.Contains(err.Error(), "kimi") || !strings.Contains(err.Error(), "zai") ||
		!strings.Contains(err.Error(), "未接受部分结果") {
		t.Fatal("旧版出口未点名来源与缺失字段", err)
	}
	p := fixtureSources(t)[0]
	p.Quotas[0].UsedPercent = ptr(101)
	if err := validateSources([]Pace{p}); err == nil || !strings.Contains(err.Error(), "窗口 ") || !strings.Contains(err.Error(), "usedPercent 缺失或越界") {
		t.Fatal("坏窗口未点名字段", err)
	}
	p = fixtureSources(t)[0]
	p.Account = ""
	if err := validateSources([]Pace{p}); err == nil || !strings.Contains(err.Error(), "缺 providerId") {
		t.Fatal("缺 providerId 未写明", err)
	}
	if err := validateSources(nil); err == nil || !strings.Contains(err.Error(), "没有来源行") {
		t.Fatal("空出口未写明", err)
	}
	t.Log("预期旧版扁平出口/坏窗口/缺标识都报来源名与具体字段；实际符合")
}

func TestSourceCacheFailureIdentity(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now().UTC()
	p := fixtureSources(t)[0]
	p.RefreshedAt = now.Format(time.RFC3339Nano)
	p.AccountIdentity = &AccountIdentity{Kind: "accountHash", Value: "synthetic-A", Source: "synthetic"}
	p.CacheIdentityMatch = "matched"
	b, _ := json.Marshal(oqStored{Rows: []Pace{p}})
	if _, err := db.ExecContext(ctx, `INSERT INTO quota_cache VALUES (?,?,?,?)`, oqKey, oqKey, string(b), now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	d := Deps{Now: func() time.Time { return now.Add(time.Minute) }}
	local := NewLocal(d)
	poll := poller{local: local, now: d.Now, oq: func(context.Context) ([]Pace, error) { return nil, errors.New("假B身份刷新失败") }}
	if err := poll.round(ctx, db); err != nil {
		t.Fatal(err)
	}
	stored, err := openquotaStored(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(stored.Rows[0], p) {
		t.Fatal("失败改变旧账号事实")
	}
	t.Log("预期刷新失败保留A身份/原时刻/全窗口；实际符合，不证明B当前套餐或真实账号绑定")
}

func ptr(v float64) *float64 { return &v }
