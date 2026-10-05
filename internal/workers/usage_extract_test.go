package workers

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/store"
)

func traeUsageSpec() UsageSpec {
	return UsageSpec{
		Event: "result", Input: "usage.input_tokens", Output: "usage.output_tokens",
		CacheRead: "usage.cache_read_input_tokens", CacheWrite: "usage.cache_creation_input_tokens",
		Cost: "total_cost_usd", Currency: "USD",
	}
}

func TestExtractUsageMeasuredLogs(t *testing.T) {
	// 只报总花费、没有 token 的日志：total_cost_usd 为 0 不记花费。
	b := `{"type":"result","subtype":"success","is_error":false,"num_turns":4,"duration_ms":13867,"total_cost_usd":0}`
	u := ExtractUsage(b, traeUsageSpec())
	if u.Input != nil || u.Output != nil || u.CacheRead != nil || u.CacheWrite != nil || u.Cost != nil {
		t.Fatalf("没有 token，total_cost_usd 为 0 不应记花费：%+v", u)
	}
	// 只有一轮闲聊、没有用量字段的日志：什么都不记。
	b = "{\"role\":\"assistant\",\"content\":\"OK\"}\n{\"role\":\"meta\",\"type\":\"session.resume_hint\",\"session_id\":\"redacted\"}"
	u = ExtractUsage(b, UsageSpec{Input: "usage.input_tokens", Output: "usage.output_tokens", Cost: "total_cost_usd", Currency: "USD"})
	if u.Input != nil || u.Output != nil || u.Cost != nil {
		t.Fatalf("没有用量字段的日志不该记：%+v", u)
	}
}

func TestExtractUsageDeclaredPaths(t *testing.T) {
	spec := traeUsageSpec()
	log := `{"type":"assistant","usage":{"input_tokens":9}}
{"type":"result","subtype":"success","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":50,"cache_creation_input_tokens":0},"total_cost_usd":0}
{"type":"result","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"total_cost_usd":0}
`
	u := ExtractUsage(log, spec)
	if !reflect.DeepEqual(u.Tokens, Tokens{token(110), token(25), token(50), token(0)}) {
		t.Fatalf("token %+v", u.Tokens)
	}
	if u.Cost != nil {
		t.Fatalf("花费 0 不应记：%+v", u)
	}
	paid := `{"type":"result","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"total_cost_usd":1.25}`
	u = ExtractUsage(paid, spec)
	if u.Cost == nil || math.Abs(*u.Cost-1.25) > 1e-12 || u.Currency != "USD" || u.Source != "tool" {
		t.Fatalf("花费 %+v", u)
	}
	crlf := "{\"type\":\"result\",\"usage\":{\"input_tokens\":3,\"output_tokens\":1,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0},\"total_cost_usd\":0}\r\n"
	u = ExtractUsage(crlf, spec)
	if u.Input == nil || *u.Input != 3 || u.Cost != nil {
		t.Fatalf("CRLF 与花费 0：%+v", u)
	}
}

func TestExtractUsageIgnoresBroken(t *testing.T) {
	spec := traeUsageSpec()
	u := ExtractUsage("not json\n{\"type\":\"result\"}\n", spec)
	if u.Input != nil || u.Cost != nil {
		t.Fatal(u)
	}
	u = ExtractUsage(`{"type":"result","usage":{"input_tokens":-1,"output_tokens":1.5}}`, spec)
	if u.Input != nil || u.Output != nil {
		t.Fatal(u)
	}
}

func TestUsageSpecProfile(t *testing.T) {
	ok := "model: zcode/GLM-5.3[1m]\nusage: {event: result, input: usage.input_tokens, cost: total_cost_usd, currency: USD}"
	for _, c := range []struct {
		src string
		ok  bool
		err string
	}{
		{ok, true, ""},
		{"model: zcode/GLM-5.3[1m]\nusage: {input: usage.input_tokens}", true, ""},
		{"model: zcode/GLM-5.3[1m]\nusage: {}", false, "至少写一个"},
		{"model: zcode/GLM-5.3[1m]\nusage: {input: \"usage..tokens\"}", false, "点分字段路径"},
		{"model: zcode/GLM-5.3[1m]\nusage: {event: \" result\"}", false, "事件 type"},
		{"model: zcode/GLM-5.3[1m]\nusage: {cost: total_cost_usd}", false, "三位大写货币"},
		{"model: zcode/GLM-5.3[1m]\nusage: {input: usage.input_tokens, currency: USD}", false, "只在写了 cost"},
		{"model: zcode/GLM-5.3[1m]\nusage: {input: usage.input_tokens, extra: 1}", false, "规则写得不对"},
		{"model: zcode/GLM-5.3[1m]\nusage: {input: a, cache_read: b, input_includes_cache_read: true}", true, ""},
		{"model: zcode/GLM-5.3[1m]\nusage: {input: a, input_includes_cache_read: true}", false, "同时写 input 与 cache_read"},
	} {
		keys, _, err := SplitSource("---\n" + c.src + "\n---\n")
		if err != nil {
			t.Fatal(err)
		}
		err = CheckProfile("harness/dsh", keys)
		if c.ok {
			if err != nil {
				t.Fatalf("%s：应能用，得到 %v", c.src, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), c.err) {
			t.Fatalf("%s：应报 %q，得到 %v", c.src, c.err, err)
		}
	}
}

func TestRunUsageDeclared(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	src := `---
model: zcode/GLM-5.3[1m]
usage:
  event: result
  input: usage.input_tokens
  output: usage.output_tokens
  cache_read: usage.cache_read_input_tokens
  cache_write: usage.cache_creation_input_tokens
  cost: total_cost_usd
  currency: USD
billing: metered
prices: {currency: CNY, input: 6, output: 30, cache_read: 1.2}
---
`
	if _, err := SaveProfile(ctx, db, "harness/dsh", Edit{Source: &src}, "u1"); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "run.log")
	line := `{"type":"result","subtype":"success","usage":{"input_tokens":1000000,"output_tokens":1000000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"total_cost_usd":0}` + "\n"
	if err := os.WriteFile(log, []byte(line), 0600); err != nil {
		t.Fatal(err)
	}
	u, err := RunUsage(ctx, db, "t1", Run{N: 1, Worker: "dsh", Log: log})
	if err != nil {
		t.Fatal(err)
	}
	if u.Billing != "metered" || u.Source != "estimate" || u.Currency != "CNY" || u.Cost == nil || math.Abs(*u.Cost-36) > 1e-12 {
		t.Fatalf("应按档案单价估算：%+v", u)
	}
	if !strings.Contains(u.String(), "花费") || !strings.Contains(u.String(), "估算") {
		t.Fatal(u.String())
	}
	m92 := `{"type":"result","subtype":"success","result":"这行没有用量字段"}` + "\n"
	if err := os.WriteFile(log, []byte(m92), 0600); err != nil {
		t.Fatal(err)
	}
	u, err = RunUsage(ctx, db, "t1", Run{N: 2, Worker: "dsh", Log: log})
	if err != nil || u.Input != nil || u.Cost != nil || strings.Count(u.String(), "读不到") != 4 {
		t.Fatalf("没有 token 不硬估：%+v %v", u, err)
	}
	// 没写 usage 声明就走 dsh 的内置解析：别的工具的事件格式猜不出用量。
	plain := "---\nmodel: zcode/GLM-5.3[1m]\n---\n"
	if _, err := SaveProfile(ctx, db, "harness/dsh", Edit{Source: &plain}, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(log, []byte(line), 0600); err != nil {
		t.Fatal(err)
	}
	u, err = RunUsage(ctx, db, "t1", Run{N: 3, Worker: "dsh", Log: log})
	if err != nil || u.Input != nil || u.Cost != nil {
		t.Fatalf("没写 usage 不从日志猜：%+v %v", u, err)
	}
}
