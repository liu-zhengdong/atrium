package workers

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// traeProfile 同线上 harness/trae（09-30）：trae 不报 cache_creation，缓存写读不到也没单价。
const traeProfile = `---
protocol: cli
command: trae-cli
args: ["{prompt}"]
usage:
  event: result
  input: usage.input_tokens
  output: usage.output_tokens
  cache_read: usage.cache_read_input_tokens
  cache_write: usage.cache_creation_input_tokens
  cost: total_cost_usd
  currency: USD
  input_includes_cache_read: true
billing: metered
prices: {currency: CNY, input: 6, output: 30, cache_read: 1.2}
---
`

func traeDB(t *testing.T) (context.Context, *store.DB) {
	t.Helper()
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	src := traeProfile
	if _, err := SaveProfile(ctx, db, "harness/trae", Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	return ctx, db
}

// m109 是 trae-cli 0.120.52 实测：assistant 行 prompt_tokens=15458 含 cached_tokens=7480，result 行 input_tokens 同为 15458，
// 所以 result 的 input 含缓存读，要扣掉才是普通输入。
func TestTraeInputIncludesCacheRead(t *testing.T) {
	b, err := os.ReadFile("testdata/cli-trae-m109.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"prompt_tokens":15458,"prompt_token_details":{"cached_tokens":7480}`) {
		t.Fatal("样本变了")
	}
	spec := traeUsageSpec()
	spec.InputHasCacheRead = true
	u := ExtractUsage(string(b), spec)
	if u.Input == nil || *u.Input != 15458-7480 || *u.CacheRead != 7480 || *u.Output != 38 || u.CacheWrite != nil {
		t.Fatalf("%+v", u.Tokens)
	}
	for _, log := range []string{
		`{"type":"result","usage":{"input_tokens":10,"output_tokens":1}}`,
		`{"type":"result","usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":11}}`,
	} {
		if u := ExtractUsage(log, spec); u.Input != nil || u.Output == nil {
			t.Fatalf("缓存读缺或大于输入时扣不出普通输入，按读不到记：%s → %+v", log, u.Tokens)
		}
	}
}

// t685 第 1 次拉起（trae@h1，09-30）的真实读数：input 3178076（含缓存读）/ output 24939 / cache_read 3069120，没有 cache_creation。
// 普通输入 108956×6 + 24939×30 + 3069120×1.2，每百万 → 5.08485 元；input 不扣缓存读会算成 23.49957 元。
func TestTraeT685Estimate(t *testing.T) {
	ctx, db := traeDB(t)
	log := filepath.Join(t.TempDir(), "run.log")
	b, err := os.ReadFile("testdata/cli-trae-t685-usage.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(log, b, 0600); err != nil {
		t.Fatal(err)
	}
	u, err := RunUsage(ctx, db, "t1", Run{N: 1, Worker: "trae", Log: log})
	if err != nil {
		t.Fatal(err)
	}
	if u.Source != "estimate" || u.Currency != "CNY" || u.Cost == nil || math.Abs(*u.Cost-5.08485) > 1e-9 || len(u.Missing) != 0 {
		t.Fatalf("%+v cost=%v", u, u.Cost)
	}
	if s := u.String(); !strings.Contains(s, "花费 CNY 5.08485（估算）") || !strings.Contains(s, "输入 108956") {
		t.Fatal(s)
	}
}

func TestChargePartial(t *testing.T) {
	r := Rules{Billing: "metered", Prices: &Prices{Currency: "CNY", Input: price(6), Output: price(30), CacheRead: price(1.2)}}
	for _, c := range []struct {
		name    string
		tokens  Tokens
		prices  *Prices
		cost    *float64
		missing string
	}{
		{"没有缓存写这一类", Tokens{token(1e6), token(1e6), token(1e6), nil}, r.Prices, price(37.2), ""},
		{"输入读不到", Tokens{nil, token(1e6), token(1e6), nil}, r.Prices, price(31.2), "输入"},
		{"缓存写有 token 没单价", Tokens{token(1e6), token(0), token(0), token(5)}, r.Prices, price(6), "缓存写"},
		{"缓存写有单价读不到", Tokens{token(1e6), token(0), token(0), nil}, &Prices{Currency: "CNY", Input: price(6), CacheWrite: price(7.5)}, price(6), "缓存写"},
		{"一类都算不进", Tokens{nil, nil, nil, nil}, r.Prices, nil, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			u := Charge(Usage{Tokens: c.tokens}, Rules{Billing: "metered", Prices: c.prices})
			if (u.Cost == nil) != (c.cost == nil) || (c.cost != nil && math.Abs(*u.Cost-*c.cost) > 1e-9) || strings.Join(u.Missing, "、") != c.missing {
				t.Fatalf("%+v", u)
			}
			if c.missing != "" && !strings.Contains(u.String(), "估算，未含"+c.missing) {
				t.Fatal(u.String())
			}
		})
	}
}

// 回填：t685 第 1 次按旧逻辑存下的退出记录（有 token、没花费），补算后 workers 统计能看到估算花费；日志不在就报错不动记录。
func TestRecount(t *testing.T) {
	ctx, db := traeDB(t)
	tk, err := ledger.Add(ctx, db, ledger.NewTask{Title: "trae 干的活"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "run-1.log")
	b, _ := os.ReadFile("testdata/cli-trae-t685-usage.ndjson")
	if err := os.WriteFile(log, b, 0600); err != nil {
		t.Fatal(err)
	}
	record := func(kind string, v any) {
		raw, _ := json.Marshal(v)
		if err := ledger.Record(ctx, db, tk.ID, kind, "runtime", string(raw)); err != nil {
			t.Fatal(err)
		}
	}
	record(RunKind, Run{N: 1, Worker: "trae", Host: "h1", Log: log})
	old := Usage{Tokens: Tokens{token(3178076), token(24939), token(3069120), nil}, Billing: "metered"}
	record(ExitKind, Exit{N: 1, Outcome: OutBounce, Reason: "审阅打回", Usage: old})

	out, err := Recount(ctx, db, tk.ID, "a1")
	if err != nil || len(out) != 1 || out[0].Before.Cost != nil || out[0].After.Cost == nil {
		t.Fatalf("%+v %v", out, err)
	}
	u, err := ExitUsage(ctx, db, tk.ID, 1)
	if err != nil || u.Cost == nil || math.Abs(*u.Cost-5.08485) > 1e-9 || u.Source != "estimate" || *u.Input != 108956 {
		t.Fatalf("%+v %v", u, err)
	}
	st, err := Stats(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if a := st["trae"]; len(a) != 1 || a[0].Outcome != OutBounce || a[0].Usage.Cost == nil {
		t.Fatalf("统计要读到补算后的花费，结果不变：%+v", st)
	}
	if s := Count(st["trae"]).UsageText(); !strings.Contains(s, "花费 CNY 合计 5.08485") || !strings.Contains(s, "1 次估算") {
		t.Fatal(s)
	}
	var body string
	if err := db.QueryRowContext(ctx, `SELECT body FROM task_events WHERE task = ? AND kind = ?`, tk.ID, RecountKind).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if s, err := RecountText(body); err != nil || !strings.Contains(s, "第 1 次拉起按当前档案重新结算") || !strings.Contains(s, "估算") {
		t.Fatal(s, err)
	}

	if err := os.Remove(log); err != nil {
		t.Fatal(err)
	}
	if _, err := Recount(ctx, db, tk.ID, "a1"); err == nil || !strings.Contains(err.Error(), "日志读不了") {
		t.Fatalf("日志不在要报错：%v", err)
	}
	if u, _ := ExitUsage(ctx, db, tk.ID, 1); u.Cost == nil || *u.Input != 108956 {
		t.Fatalf("报错时不动记录：%+v", u)
	}
}
