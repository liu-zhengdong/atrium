package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/config"
)

func testTable() (*Table, *Ctx) {
	t := NewTable("atrium", "测试")
	t.Group("task", "任务")
	var got Ctx
	t.Add(Command{Path: "task add", Args: "<标题>", Summary: "建任务",
		Flags: []Flag{{Name: "org"}, {Name: "after", Multi: true}, {Name: "top", Bool: true}},
		Run: func(c *Ctx) error {
			got = *c
			return c.Done(map[string]string{"id": "t1"}, "已建 t1", "atrium task run t1")
		}})
	t.Add(Command{Path: "status", Summary: "看服务", Read: true, Run: func(c *Ctx) error { return c.Done(nil, "", "") }})
	return t, &got
}

func run(t *Table, env map[string]string, args ...string) (int, string, string) {
	var out, errb bytes.Buffer
	code := t.Main(context.Background(), args, Env{Stdout: &out, Stderr: &errb, Getenv: func(k string) string { return env[k] }})
	return code, out.String(), errb.String()
}

func TestParse(t *testing.T) {
	tbl, got := testTable()
	code, out, _ := run(tbl, nil, "task", "add", "修 登录", "--org=o1", "--after", "t2,t3", "--after", "t4", "--top")
	if code != 0 || out != "已建 t1\n下一步：atrium task run t1\n" {
		t.Fatalf("code %d out %q", code, out)
	}
	if !reflect.DeepEqual(got.Args, []string{"修 登录"}) || got.Str("org") != "o1" || !got.Bool("top") ||
		!reflect.DeepEqual(got.List("after"), []string{"t2", "t3", "t4"}) || got.Opt("missing") != nil {
		t.Fatalf("解析不对：%+v", got)
	}
	// -- 之后都是位置参数
	run(tbl, nil, "task", "add", "--", "--org")
	if !reflect.DeepEqual(got.Args, []string{"--org"}) {
		t.Fatalf("got %v", got.Args)
	}
}

func TestErrorsAndJSON(t *testing.T) {
	tbl, _ := testTable()
	cases := []struct {
		args     []string
		code     int
		errCode  string
		stderrIn string
	}{
		{[]string{"task", "add", "x", "--nope"}, 2, "usage", "不认识这个参数"},
		{[]string{"task", "add", "x", "--org"}, 2, "usage", "缺值"},
		{[]string{"task", "add", "x", "--org", "a", "--org", "b"}, 2, "usage", "只能给一次"},
		{[]string{"task", "add", "x", "--top=1"}, 2, "usage", "开关"},
		{[]string{"nope"}, 2, "usage", "没有这个命令"},
	}
	for _, c := range cases {
		code, _, stderr := run(tbl, nil, c.args...)
		if code != c.code || !strings.Contains(stderr, c.stderrIn) {
			t.Errorf("%v: code %d stderr %q", c.args, code, stderr)
		}
		_, out, _ := run(tbl, nil, append(c.args, "--json")...)
		var env struct {
			OK    bool
			Error struct{ Code, Message string }
		}
		if json.Unmarshal([]byte(out), &env) != nil || env.OK || env.Error.Code != c.errCode {
			t.Errorf("%v --json: %q", c.args, out)
		}
	}
	_, out, _ := run(tbl, nil, "task", "add", "x", "--json")
	if out != `{"next":"atrium task run t1","ok":true,"result":{"id":"t1"}}`+"\n" {
		t.Fatalf("成功信封 %q", out)
	}
}

func TestWorkerGuard(t *testing.T) {
	tbl, _ := testTable()
	worker := map[string]string{"ATRIUM_WORKER": "1"}
	if code, _, stderr := run(tbl, worker, "task", "add", "x"); code != 1 || !strings.Contains(stderr, "执行者") {
		t.Fatalf("执行者应被拒：%d %q", code, stderr)
	}
	if code, _, _ := run(tbl, worker, "status"); code != 0 {
		t.Fatal("只读命令应放行")
	}
	isolated := map[string]string{"ATRIUM_WORKER": "1", "ATRIUM_DATA": t.TempDir()}
	if code, _, stderr := run(tbl, isolated, "task", "add", "x"); code != 0 {
		t.Fatalf("隔离实例上的写命令应放行：%d %q", code, stderr)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	explicit := map[string]string{"ATRIUM_WORKER": "1", "ATRIUM_DATA": filepath.Join(home, ".atrium-v2")}
	if code, _, _ := run(tbl, explicit, "task", "add", "x"); code != 1 {
		t.Fatal("ATRIUM_DATA 写成缺省目录仍是用户的服务，应拒")
	}
}

func TestHelp(t *testing.T) {
	tbl, _ := testTable()
	_, top, _ := run(tbl, nil, "--help")
	for _, want := range []string{"status", "任务（task）", "task add <标题>", "下一步：atrium <命令> --help"} {
		if !strings.Contains(top, want) {
			t.Errorf("顶层帮助缺 %q：\n%s", want, top)
		}
	}
	_, group, _ := run(tbl, nil, "task")
	if !strings.Contains(group, "task add") || strings.Contains(group, "status") {
		t.Errorf("组帮助：\n%s", group)
	}
	_, cmd, _ := run(tbl, nil, "task", "add", "--help")
	if !strings.Contains(cmd, "--after <值> …") || !strings.Contains(cmd, "--top ") || !strings.Contains(cmd, "--json") {
		t.Errorf("命令帮助：\n%s", cmd)
	}
}

func TestRegistrationPanics(t *testing.T) {
	mustPanic := func(name string, f func()) {
		defer func() {
			if recover() == nil {
				t.Errorf("%s 应 panic", name)
			}
		}()
		f()
	}
	tbl, _ := testTable()
	mustPanic("重复命令", func() { tbl.Add(Command{Path: "task add"}) })
	mustPanic("未声明的组", func() { tbl.Add(Command{Path: "ghost run"}) })
	mustPanic("重复组", func() { tbl.Group("task", "x") })
}

// 负责人进程带 ATRIUM_LEADER_TOKEN：经服务的调用用它，不读用户令牌文件。
func TestLeaderToken(t *testing.T) {
	var seen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("Authorization")
		w.Write([]byte(`{"ok":true,"result":null}`))
	}))
	defer srv.Close()
	dir := t.TempDir()
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	if err := config.WriteService(config.Paths{Data: dir}, config.ServiceInfo{PID: 1, Port: port}); err != nil {
		t.Fatal(err)
	}
	tb := NewTable("atrium", "测试")
	tb.Add(Command{Path: "ping", Summary: "x", Run: func(c *Ctx) error { return c.Call("GET", "/api/x", nil, nil) }})
	if code, _, e := run(tb, map[string]string{"ATRIUM_DATA": dir, "ATRIUM_LEADER_TOKEN": "lt_abc"}, "ping"); code != 0 || seen != "Bearer lt_abc" {
		t.Fatalf("code=%d seen=%q %s", code, seen, e)
	}
	if code, _, _ := run(tb, map[string]string{"ATRIUM_DATA": dir}, "ping"); code == 0 {
		t.Fatal("没有负责人令牌时读用户令牌文件，文件不存在应报错")
	}
}
