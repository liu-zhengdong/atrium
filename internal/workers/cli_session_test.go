package workers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
)

const cliSessionID = "12345678-1234-1234-1234-123456789abc"

func TestCLISessionValidation(t *testing.T) {
	valid := CLISpec{Command: "fake", Args: []string{"{session_args}", "{prompt}"},
		SessionArgs: []string{"--resume", "{session}"}, SessionMatch: `"session_id":"([0-9a-f-]{36})"`}
	if p := valid.Problems("fake"); len(p) != 0 {
		t.Fatal(p)
	}
	for _, tc := range []struct {
		name   string
		change func(*CLISpec)
		want   string
	}{
		{"无捕获组", func(s *CLISpec) { s.SessionMatch = `session_id` }, "恰有一个捕获组"},
		{"多个捕获组", func(s *CLISpec) { s.SessionMatch = `(session)=(id)` }, "恰有一个捕获组"},
		{"坏正则", func(s *CLISpec) { s.SessionMatch = `(` }, "不是合法正则"},
		{"无正则", func(s *CLISpec) { s.SessionMatch = "" }, "必须一起写"},
		{"无会话占位", func(s *CLISpec) { s.SessionArgs = []string{"--resume"} }, "必须一起写"},
		{"无组入口", func(s *CLISpec) { s.Args = []string{"{prompt}"} }, "没有 {session_args}"},
		{"嵌套组", func(s *CLISpec) { s.SessionArgs = []string{"{model_args}", "{session}"} }, "单独占一项"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := valid
			tc.change(&s)
			if p := strings.Join(s.Problems("fake"), ";"); !strings.Contains(p, tc.want) {
				t.Fatalf("应拒绝 %s，得到 %s", tc.want, p)
			}
		})
	}
	for _, layer := range []string{"models/m1", "combos/fake+m1"} {
		if err := CheckProfile(layer, map[string]any{"session_match": valid.SessionMatch}); err == nil {
			t.Fatalf("%s 不应接受 CLI 字段", layer)
		}
	}
	plain := cliAdapter("fake", CLISpec{Command: "fake"})
	if plain.CanResume() || plain.Tell != TellRestart || plain.SessionOf("anything") != "" {
		t.Fatal("未声明会话的档案改变了行为")
	}
}

func TestCLISessionOpaqueID(t *testing.T) {
	spec := CLISpec{Command: "fake", Args: []string{"{session_args}", "{prompt}"},
		SessionArgs: []string{"--resume", "{session}"}, SessionMatch: `"sessionId":"([^"]+)"`}
	a := cliAdapter("fake", spec)
	id := "sess_1bf49c3a-1128-49a2-a023-9c434bb616c0"
	if got := a.SessionOf(`{"sessionId":"` + id + `"}`); got != id {
		t.Fatalf("会话 id = %q", got)
	}
	for _, tc := range []struct {
		id    string
		valid bool
	}{
		{id, true}, {cliSessionID, true}, {strings.Repeat("a", 128), true},
		{strings.Repeat("a", 129), false}, {"--bad", false}, {"../session", false},
		{"a/b", false}, {"a\\b", false}, {"a\narg", false}, {"a b", false},
	} {
		_, err := Build("fake", Request{CLI: &spec, Dir: t.TempDir(), Prompt: "x", Session: tc.id})
		if (err == nil) != tc.valid {
			t.Errorf("会话 %q：err=%v", tc.id, err)
		}
	}
	if _, err := Build("codex", Request{Dir: t.TempDir(), Prompt: "x", Session: id}); err == nil {
		t.Fatal("内置工具的会话约束不应改变")
	}
}

// 假 CLI 只读写测试工作目录，两次进程通过会话文件验证续接时保留了第一轮内容。
func TestCLISessionProcess(t *testing.T) {
	if os.Getenv("ATRIUM_FAKE_CLI_SESSION") != "1" {
		return
	}
	args := os.Args
	for len(args) > 0 && args[0] != "--" {
		args = args[1:]
	}
	if len(args) == 2 && args[1] == "first" {
		if err := os.WriteFile("session.txt", []byte("first"), 0600); err != nil {
			os.Exit(2)
		}
	} else if len(args) == 4 && args[1] == "--resume" && args[2] == cliSessionID && args[3] == "second" {
		b, err := os.ReadFile("session.txt")
		if err != nil || string(b) != "first" {
			os.Exit(3)
		}
	} else {
		os.Exit(4)
	}
	fmt.Printf("{\"session_id\":\"%s\"}\nDONE\n", cliSessionID)
	os.Exit(0)
}

func TestCLISessionRoundTrip(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	source := `---
protocol: cli
command: fake
args: ["{session_args}", "{prompt}"]
session_args: ["--resume", "{session}"]
session_match: '"session_id":"([0-9a-f-]{36})"'
done_match: '^DONE$'
auto: false
---
`
	ctx := context.Background()
	if _, err := SaveProfile(ctx, db, "harness/fake", Edit{Source: &source}, "u1"); err != nil {
		t.Fatal(err)
	}
	r, err := Resolve(ctx, db, "fake")
	if err != nil {
		t.Fatal(err)
	}
	if !r.Adapter.CanResume() || r.Adapter.Tell != TellResume {
		t.Fatal("档案未启用续接")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	session := ""
	for _, prompt := range []string{"first", "second"} {
		req := r.Request(prompt, "", dir)
		req.Session = session
		// 代理端通过 JSON 收到同一份 CLI 声明。
		b, err := json.Marshal(req)
		if err != nil {
			t.Fatal(err)
		}
		var remote Request
		if err := json.Unmarshal(b, &remote); err != nil {
			t.Fatal(err)
		}
		launch, err := Build("fake", remote)
		if err != nil {
			t.Fatal(err)
		}
		want := []string{prompt}
		if session != "" {
			want = []string{"--resume", session, prompt}
		}
		if !reflect.DeepEqual(launch.Args, want) {
			t.Fatalf("%v != %v", launch.Args, want)
		}
		var out bytes.Buffer
		cmd, err := platform.Start(platform.Spec{Path: exe, Args: append([]string{"-test.run=^TestCLISessionProcess$", "--"}, launch.Args...),
			Dir: launch.Dir, Env: map[string]string{"ATRIUM_FAKE_CLI_SESSION": "1"}, Stdout: &out, Stderr: &out})
		if err != nil {
			t.Fatal(err)
		}
		finished := make(chan error, 1)
		go func() { finished <- cmd.Wait() }()
		select {
		case err := <-finished:
			if err != nil {
				t.Fatalf("假 CLI：%v %s", err, out.String())
			}
		case <-time.After(10 * time.Second):
			_ = platform.KillTree(cmd.Process.Pid)
			<-finished
			t.Fatal("假 CLI 超时")
		}
		session = r.Adapter.SessionOf(out.String())
		if session != cliSessionID || !r.Adapter.Ended(out.String()).OK {
			t.Fatalf("日志：%s", out.String())
		}
		t.Logf("%s：会话 %s，DONE", prompt, session)
	}
	if r.Adapter.SessionOf("broken session event") != "" {
		t.Fatal("坏日志不应产生会话")
	}
	if _, err := Build("fake", Request{CLI: r.Adapter.cli, Dir: dir, Prompt: "x", Session: "--bad"}); err == nil {
		t.Fatal("坏会话 id 未拒绝")
	}
}
