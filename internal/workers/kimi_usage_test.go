package workers

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const kimiLog = `{"role":"meta","type":"system.version","version":"2.1.1"}
{"role":"assistant","content":"OK"}
{"role":"meta","type":"session.resume_hint","session_id":"session_1f7c2b99","command":"kimi -r session_1f7c2b99","content":"To resume this session: kimi -r session_1f7c2b99"}
`

// wire 行的形状同 kimi 2.1.1 的 usage.record（type、time、agentId、model、usage、usageScope 平铺），其他记录不计。
func kimiWire(t *testing.T, home, agent string, lines ...string) {
	t.Helper()
	dir := filepath.Join(home, "sessions", "wd_abc", "session_1f7c2b99", "agents", agent)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "wire.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func kimiRun(t *testing.T, home string) (string, Trace) {
	t.Helper()
	log := filepath.Join(t.TempDir(), "run-1.log")
	if err := os.WriteFile(log, []byte(kimiLog), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := AfterExit("kimi", log, map[string]string{"KIMI_CODE_HOME": home}); err != nil {
		t.Fatal(err)
	}
	tr, err := ReadTrace("kimi", log)
	if err != nil {
		t.Fatal(err)
	}
	return log, tr
}

func TestKimiAfterExitUsage(t *testing.T) {
	home := t.TempDir()
	kimiWire(t, home, "main",
		`{"type":"metadata","protocol_version":"1.5","created_at":1}`,
		`{"type":"usage.record","time":1,"agentId":"main","model":"k2","usage":{"inputOther":100,"output":20,"inputCacheRead":1000,"inputCacheCreation":10},"usageScope":"turn"}`,
		`{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":999}}}`,
		`{"type":"usage.record","time":2,"agentId":"main","model":"k2","usage":{"inputOther":5,"output":1,"inputCacheRead":0,"inputCacheCreation":0},"usageScope":"session"}`)
	kimiWire(t, home, "sub1",
		`{"type":"usage.record","time":3,"agentId":"sub1","model":"k2","usage":{"inputOther":1,"output":2,"inputCacheRead":3,"inputCacheCreation":4},"usageScope":"turn"}`)
	log, tr := kimiRun(t, home)
	want := Tokens{token(106), token(23), token(1003), token(14)}
	if tr.Unknown != 0 || tr.Result != "OK" || !reflect.DeepEqual(tr.Usage.Tokens, want) || tr.Usage.Cost != nil {
		t.Fatalf("trace=%+v", tr)
	}
	d, _ := Builtin("kimi")
	b, _ := os.ReadFile(log)
	if d.LastReply(string(b)) != "OK" || d.Ended(string(b)).Known {
		t.Fatal("追加的用量行不能改变回复与收尾判断")
	}
	if AfterExit("claude", log, nil) != nil {
		t.Fatal()
	}
	if b2, _ := os.ReadFile(log); string(b2) != string(b) {
		t.Fatal("其他工具不补记")
	}
	r := Rules{Billing: "subscription", Prices: &Prices{Currency: "CNY", USDRate: price(.14), Input: price(4), Output: price(16), CacheRead: price(1), CacheWrite: price(4)}}
	if u := Charge(tr.Usage, r); u.Source != "estimate" || u.USD == nil || len(u.Missing) != 0 {
		t.Fatal(u)
	}
}

func TestKimiAfterExitMissing(t *testing.T) {
	for _, c := range []struct {
		name, want string
		setup      func(home string)
	}{
		{"没有会话目录", "目录里没有 wire.jsonl", func(string) {}},
		{"坏的 usage.record", "usage 读不了", func(home string) {
			kimiWire(t, home, "main",
				`{"type":"usage.record","usage":{"inputOther":100,"output":20,"inputCacheRead":0,"inputCacheCreation":0}}`,
				`{"type":"usage.record","usage":{"inputOther":"many"}}`)
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			home := t.TempDir()
			c.setup(home)
			_, tr := kimiRun(t, home)
			if tr.Unknown != 0 || tr.Usage.Input != nil || len(tr.Lines) != 1 || !strings.Contains(tr.Lines[0], "用量读不到") || !strings.Contains(tr.Lines[0], c.want) {
				t.Fatalf("trace=%+v", tr)
			}
		})
	}
	if _, err := kimiSessionUsage(t.TempDir(), "../x"); err == nil || !strings.Contains(err.Error(), "不合法") {
		t.Fatal(err)
	}
	if _, err := kimiSessionUsage(t.TempDir(), ""); err == nil {
		t.Fatal("没有会话 id 要说明")
	}
}
