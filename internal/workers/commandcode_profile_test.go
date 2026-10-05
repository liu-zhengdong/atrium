package workers

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestCommandCodeCLIProfile(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	for name, file := range map[string]string{
		"harness/commandcode":                  "commandcode-harness.md",
		"combos/commandcode+laguna-s-2.1-free": "commandcode-laguna-combo.md",
	} {
		b, err := os.ReadFile(filepath.Join("testdata", file))
		if err != nil {
			t.Fatal(err)
		}
		source := string(b)
		if _, err := SaveProfile(ctx, db, name, Edit{Source: &source}, "u1"); err != nil {
			t.Fatal(err)
		}
	}
	r, err := Resolve(ctx, db, "commandcode+laguna-s-2.1-free:low")
	if err != nil {
		t.Fatal(err)
	}
	if r.Adapter.Tell != TellResume || r.Rules.EffectiveAuto() {
		t.Fatal("未启用续接或误参与自动挑人")
	}
	req := r.Request("first", "", dir)
	first, err := Build("commandcode", req)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(first.Args, " "), "--resume") {
		t.Fatal("首次启动带了续接参数")
	}
	want := []string{"--print", "--output-format", "json", "--yolo", "--no-auto-update", "--skip-onboarding", "--model", "poolside/laguna-s-2.1-free", "--effort", "low", "first"}
	if first.Exe != "command-code" || !reflect.DeepEqual(first.Args, want) {
		t.Fatalf("首次启动 %+v", first)
	}
	req.Session = r.Adapter.SessionOf(`{"type":"event","event":{"type":"run_start","sessionId":"` + cliSessionID + `"}}`)
	if req.Session != cliSessionID {
		t.Fatal("未提取会话")
	}
	second, err := Build("commandcode", req)
	if err != nil {
		t.Fatal(err)
	}
	want = append(append(append([]string{}, want[:6]...), "--resume", cliSessionID), want[6:]...)
	if !reflect.DeepEqual(second.Args, want) {
		t.Fatalf("续接参数 %v", second.Args)
	}
	req.Session = "../bad"
	if _, err := Build("commandcode", req); err == nil {
		t.Fatal("未拒绝坏会话")
	}
	b, err := os.ReadFile("testdata/command-code-sample.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	log := string(b)
	if !r.Adapter.Ended(log).OK {
		t.Fatal("未认出成功收尾")
	}
	if r.Adapter.Ended(log + "\n" + `{"type":"result","subtype":"error","error":"Not authenticated"}`).OK {
		t.Fatal("错误收尾误判成功")
	}
	u := ExtractUsage(log, *r.Rules.Usage)
	if !reflect.DeepEqual(u.Tokens, Tokens{token(33444), token(142), token(20736), token(0)}) {
		t.Fatalf("用量 %+v", u)
	}
	u = Charge(u, r.Rules)
	if u.Cost == nil || *u.Cost != 0 || u.Currency != "USD" || len(u.Missing) != 0 {
		t.Fatalf("免费档计费 %+v", u)
	}
	plain, err := Resolve(ctx, db, "commandcode")
	if err != nil {
		t.Fatal(err)
	}
	if u := Charge(ExtractUsage(log, *plain.Rules.Usage), plain.Rules); u.Cost != nil {
		t.Fatal("未知价格误当免费")
	}
}
