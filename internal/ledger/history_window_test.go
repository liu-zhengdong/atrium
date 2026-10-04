package ledger

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestHistoryWindowCLI(t *testing.T) {
	f := newReadFixture(t)
	read := func(args ...string) Detail {
		t.Helper()
		out, code := f.run(t, append([]string{"task", "show", "t1", "--json"}, args...)...)
		if code != 0 {
			t.Fatalf("%s", out)
		}
		var r struct {
			Result Detail `json:"result"`
		}
		if err := json.Unmarshal([]byte(out), &r); err != nil {
			t.Fatal(err)
		}
		return r.Result
	}
	first := read()
	if len(first.History) != 20 || first.HistoryBefore == 0 || first.HistoryTotal <= 20 {
		t.Fatalf("%+v", first)
	}
	older := read("--before", fmt.Sprint(first.HistoryBefore))
	if len(older.History) == 0 || older.History[len(older.History)-1].ID >= first.History[0].ID {
		t.Fatal("分页重叠或早期经历丢失")
	}
	all := read("--history-limit", "100")
	if len(first.History)+len(older.History) != len(all.History) || len(all.History) != all.HistoryTotal {
		t.Fatal("分页漏项")
	}
	out, code := f.run(t, "task", "show", "t1")
	if code != 0 || !strings.Contains(out, "--before") || !strings.Contains(out, "--run <轮次>") {
		t.Fatalf("%s", out)
	}
	for _, args := range [][]string{{"--history-limit", "0"}, {"--history-limit", "101"}, {"--before", "-1"}, {"--before", "bad"}} {
		out, code := f.run(t, append([]string{"task", "show", "t1"}, args...)...)
		if code == 0 {
			t.Fatalf("非法窗口被接受 %v %s", args, out)
		}
	}
	t.Logf("默认20/%d条；两页无重叠、无遗漏，早期经历可取；非法窗口全部拒绝", all.HistoryTotal)
}
