package platform

import (
	"reflect"
	"testing"
)

func TestShellInvocation(t *testing.T) {
	cases := []struct {
		goos, comspec string
		want          Invocation
	}{
		{"darwin", "", Invocation{"/bin/sh", []string{"-c", "echo hi"}}},
		{"linux", "", Invocation{"/bin/sh", []string{"-c", "echo hi"}}},
		{"windows", "", Invocation{"cmd.exe", []string{"/d", "/s", "/c", "echo hi"}}},
		{"windows", `C:\W\cmd.exe`, Invocation{`C:\W\cmd.exe`, []string{"/d", "/s", "/c", "echo hi"}}},
	}
	for _, c := range cases {
		if got := ShellInvocation(c.goos, "echo hi", c.comspec); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %+v", c.goos, got)
		}
	}
}

func TestKillTreeInvocation(t *testing.T) {
	if _, ok := KillTreeInvocation("linux", 42); ok {
		t.Error("Unix 应走进程组信号")
	}
	inv, ok := KillTreeInvocation("windows", 42)
	if !ok || !reflect.DeepEqual(inv, Invocation{"taskkill", []string{"/T", "/F", "/PID", "42"}}) {
		t.Errorf("got %+v", inv)
	}
}

func TestExecutableNames(t *testing.T) {
	cases := []struct {
		goos, name, pathext string
		want                []string
	}{
		{"darwin", "claude", "", []string{"claude"}},
		{"windows", "claude", "", []string{"claude.com", "claude.exe", "claude.bat", "claude.cmd"}},
		{"windows", "claude.CMD", "", []string{"claude.CMD"}},
		{"windows", "git", ".EXE; .Cmd;bad", []string{"git.exe", "git.cmd"}},
	}
	for _, c := range cases {
		if got := ExecutableNames(c.goos, c.name, c.pathext); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s %s: got %v", c.goos, c.name, got)
		}
	}
}

func TestServiceEnv(t *testing.T) {
	base := map[string]string{
		"PATH": "/bin", "HOME": "/h", "ATRIUM_PORT": "1", "LC_ALL": "C", "HTTPS_PROXY": "p",
		"ANTHROPIC_API_KEY": "x", "GH_TOKEN": "x", "CLAUDE_CODE_SSE_PORT": "1", "HERDR_PANE": "1",
		"SSH_AUTH_SOCK": "s", "EDITOR": "vim",
	}
	env, dropped := ServiceEnv("darwin", base)
	want := map[string]string{"PATH": "/bin", "HOME": "/h", "ATRIUM_PORT": "1", "LC_ALL": "C", "HTTPS_PROXY": "p"}
	if !reflect.DeepEqual(env, want) {
		t.Errorf("env %v", env)
	}
	if !reflect.DeepEqual(dropped, []string{"ANTHROPIC_API_KEY", "CLAUDE_CODE_SSE_PORT", "GH_TOKEN", "HERDR_PANE", "SSH_AUTH_SOCK"}) {
		t.Errorf("dropped %v", dropped)
	}
	// Windows：名字不分大小写，按大写落键；系统变量放行。
	env, _ = ServiceEnv("windows", map[string]string{"Path": "C:\\", "SystemRoot": "C:\\W", "atrium_data": "d"})
	if !reflect.DeepEqual(env, map[string]string{"PATH": "C:\\", "SYSTEMROOT": "C:\\W", "ATRIUM_DATA": "d"}) {
		t.Errorf("windows env %v", env)
	}
}

func TestWorkerEnv(t *testing.T) {
	env := WorkerEnv("linux", map[string]string{
		"PATH": "/bin", "ATRIUM_DATA": "/d", "ATRIUM_PORT": "1", "OPENAI_API_KEY": "x", "CLAUDECODE": "1", "TERM": "xterm",
	})
	want := map[string]string{
		"PATH": "/bin", "TERM": "xterm", "NO_COLOR": "1", "GIT_PAGER": "cat", "PAGER": "cat",
		"GH_PROMPT_DISABLED": "1", "ATRIUM_WORKER": "1",
	}
	if !reflect.DeepEqual(env, want) {
		t.Errorf("got %v", env)
	}
}

func TestEnvRoundTrip(t *testing.T) {
	m := EnvMap([]string{"A=1", "B=x=y", "bad", "=skip"})
	if !reflect.DeepEqual(m, map[string]string{"A": "1", "B": "x=y"}) {
		t.Errorf("got %v", m)
	}
	if got := EnvList(m); !reflect.DeepEqual(got, []string{"A=1", "B=x=y"}) {
		t.Errorf("got %v", got)
	}
}

func TestMessagingEndpoint(t *testing.T) {
	cases := []struct{ goos, raw, want string }{
		{"darwin", "/tmp/cc.sock", "/tmp/cc.sock"},
		{"linux", "uds:/run/x.sock", "/run/x.sock"},
		{"linux", "relative.sock", ""},
		{"linux", "/tmp/a\nb", ""},
		{"linux", "  ", ""},
		{"windows", `\\.\pipe\claude-1`, `\\.\pipe\claude-1`},
		{"windows", `C:\tmp\x.sock`, ""},
	}
	for _, c := range cases {
		if got := MessagingEndpoint(c.goos, c.raw); got != c.want {
			t.Errorf("MessagingEndpoint(%s, %q) = %q，应为 %q", c.goos, c.raw, got, c.want)
		}
	}
}

func TestScriptInvocation(t *testing.T) {
	if got := ScriptInvocation("linux", "/r/.agents/check", ""); !reflect.DeepEqual(got, Invocation{Command: "/r/.agents/check"}) {
		t.Errorf("Unix 应直接执行：%+v", got)
	}
	want := Invocation{`C:\Git\bin\sh.exe`, []string{`C:\r\.agents\check`}}
	if got := ScriptInvocation("windows", `C:\r\.agents\check`, `C:\Git\bin\sh.exe`); !reflect.DeepEqual(got, want) {
		t.Errorf("Windows 应交给 sh：%+v", got)
	}
	if ScriptShells("darwin") != nil || !reflect.DeepEqual(ScriptShells("windows"), []string{"sh", "bash"}) {
		t.Error("ScriptShells")
	}
}
