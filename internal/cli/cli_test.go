package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
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
	t.Add(Command{Path: "status", Summary: "看服务", WorkerOK: true, Run: func(c *Ctx) error { return c.Done(nil, "", "") }})
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
		t.Fatal("WorkerOK 的命令应放行")
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
