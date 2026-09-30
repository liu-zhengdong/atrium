package platform

import (
	"path/filepath"
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
		"GH_PROMPT_DISABLED": "1", "ATRIUM_WORKER": "1", "GOFLAGS": "-trimpath",
	}
	if !reflect.DeepEqual(env, want) {
		t.Errorf("got %v", env)
	}
}

func TestGoFlagsThroughServiceAndWorker(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "windows"} {
		for _, flags := range []string{"", "-mod=readonly -p=2", `-ldflags='-X main.name=hello world'`, "-trimpath=false"} {
			t.Run(goos+"/"+flags, func(t *testing.T) {
				key := "GOFLAGS"
				if goos == "windows" {
					key = "GoFlags"
				}
				base := map[string]string{key: flags, "OPENAI_API_KEY": "secret"}
				service, _ := ServiceEnv(goos, base)
				if service["GOFLAGS"] != flags {
					t.Fatalf("服务丢失 Go 选项：%q", service["GOFLAGS"])
				}
				// 本机经服务环境，远程代理也可直接用机器环境；两条路径同一规则。
				for _, input := range []map[string]string{base, service} {
					worker := WorkerEnv(goos, input)
					want := flags + " -trimpath"
					if flags == "" {
						want = "-trimpath"
					}
					if worker["GOFLAGS"] != want || worker["OPENAI_API_KEY"] != "" {
						t.Fatalf("执行者选项或凭据过滤错误：%v", worker)
					}
				}
				if base[key] != flags {
					t.Fatal("修改了原环境")
				}
			})
		}
	}
}

func TestEnvRoundTrip(t *testing.T) {
	m := envMap("linux", []string{"A=1", "B=x=y", "bad", "=skip", "Path=p"})
	if !reflect.DeepEqual(m, map[string]string{"A": "1", "B": "x=y", "Path": "p"}) {
		t.Errorf("got %v", m)
	}
	// Windows 的 os.Environ() 里是 Path、SystemRoot：落成大写，LookPath 按 PATH 才找得到。
	if w := envMap("windows", []string{"Path=C:\\npm", "SystemRoot=C:\\W"}); !reflect.DeepEqual(w, map[string]string{"PATH": "C:\\npm", "SYSTEMROOT": "C:\\W"}) {
		t.Errorf("windows got %v", w)
	}
	m = envMap("linux", []string{"A=1", "B=x=y"})
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

func TestIsBatch(t *testing.T) {
	cases := []struct {
		goos, path string
		want       bool
	}{
		{"windows", `C:\Users\a\AppData\Roaming\npm\claude.cmd`, true},
		{"windows", `C:\x\run.BAT`, true},
		{"windows", `C:\x\codex.exe`, false},
		{"windows", `C:\x\cmd`, false},
		{"linux", "/usr/bin/claude.cmd", false},
		{"darwin", "/x/run.bat", false},
	}
	for _, c := range cases {
		if got := IsBatch(c.goos, c.path); got != c.want {
			t.Errorf("IsBatch(%s, %s) = %v", c.goos, c.path, got)
		}
	}
}

func TestBatchCommandLine(t *testing.T) {
	const script = `C:\Users\a b\npm\claude.cmd`
	cases := []struct {
		comspec string
		args    []string
		want    string
	}{
		{"", nil, `"cmd.exe" /d /e:on /v:off /s /c ""C:\Users\a b\npm\claude.cmd""`},
		{`C:\W\cmd.exe`, []string{"-p", "--model", "opus", "C:\\d\\x.txt"},
			`"C:\W\cmd.exe" /d /e:on /v:off /s /c ""C:\Users\a b\npm\claude.cmd" -p --model opus C:\d\x.txt"`},
		// 空参数、空白、cmd 元字符一律加引号。
		{"", []string{"", "a b", "x&y|z<w>v^u"}, `"cmd.exe" /d /e:on /v:off /s /c ""C:\Users\a b\npm\claude.cmd" "" "a b" "x&y|z<w>v^u""`},
		// 引号写两遍、之前的反斜杠加倍；结尾反斜杠加倍。
		{"", []string{`model_reasoning_effort="high"`, `a\"b`, `C:\dir\`},
			`"cmd.exe" /d /e:on /v:off /s /c ""C:\Users\a b\npm\claude.cmd" "model_reasoning_effort=""high""" "a\\""b" "C:\dir\\""`},
		// % 前插空子串，挡住 %PATH% 展开。
		{"", []string{"%PATH%"}, `"cmd.exe" /d /e:on /v:off /s /c ""C:\Users\a b\npm\claude.cmd" "%%cd:~,%PATH%%cd:~,%""`},
		// 非 ASCII 原样。
		{"", []string{"你好"}, `"cmd.exe" /d /e:on /v:off /s /c ""C:\Users\a b\npm\claude.cmd" 你好"`},
	}
	for _, c := range cases {
		got, err := BatchCommandLine(c.comspec, script, c.args)
		if err != nil || got != c.want {
			t.Errorf("%q:\n got %s %v\nwant %s", c.args, got, err, c.want)
		}
	}
	for _, bad := range []string{"line1\nline2", "a\rb", "a\x00b"} {
		if _, err := BatchCommandLine("", script, []string{"-p", bad}); err == nil {
			t.Errorf("%q 应拒绝", bad)
		}
	}
}

func TestWorkerTaskTemp(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "windows"} {
		t.Run(goos, func(t *testing.T) {
			base := map[string]string{"TMPDIR": "old", "TMP": "old", "TEMP": "old", "OPENAI_API_KEY": "secret"}
			env := WorkerEnv(goos, base, "/data/tasks/t1/tmp")
			for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
				if env[key] != "/data/tasks/t1/tmp" {
					t.Fatalf("%s=%q", key, env[key])
				}
				if base[key] != "old" {
					t.Fatal("修改原环境")
				}
			}
			if env["OPENAI_API_KEY"] != "" {
				t.Fatal("继承了凭据")
			}
		})
	}
}

func TestChromeActivePortPath(t *testing.T) {
	for _, c := range []struct{ goos, home, local, xdg, want string }{
		{"darwin", "home", "local", "xdg", filepath.Join("home", "Library", "Application Support", "Google", "Chrome", "DevToolsActivePort")},
		{"windows", "home", "local", "xdg", filepath.Join("local", "Google", "Chrome", "User Data", "DevToolsActivePort")},
		{"linux", "home", "local", "xdg", filepath.Join("xdg", "google-chrome", "DevToolsActivePort")},
		{"linux", "home", "local", "", filepath.Join("home", ".config", "google-chrome", "DevToolsActivePort")},
	} {
		if got := ChromeActivePortPath(c.goos, c.home, c.local, c.xdg); got != c.want {
			t.Fatalf("%s: %s", c.goos, got)
		}
	}
}
