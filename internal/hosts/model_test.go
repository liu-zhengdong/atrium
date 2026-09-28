package hosts

import (
	"reflect"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/liu-zhengdong/atrium/internal/workers"
)

func TestConnection(t *testing.T) {
	now := int64(1_000_000)
	cases := []struct {
		kind          string
		joined        bool
		expires, seen int64
		polling       bool
		want          Conn
	}{
		{"local", false, 0, 0, false, ConnLocal},
		{"remote", false, now + 1, 0, false, ConnPending},
		{"remote", false, now - 1, 0, false, ConnExpired},
		{"remote", true, 0, now - onlineMs, false, ConnOnline},
		{"remote", true, 0, now - onlineMs - 1, false, ConnOffline},
		{"remote", true, 0, 0, true, ConnOnline},
	}
	for i, c := range cases {
		if got := Connection(c.kind, c.joined, c.expires, c.seen, c.polling, now); got != c.want {
			t.Errorf("#%d: %s，应为 %s", i, got, c.want)
		}
	}
	if s := ConnText(ConnOffline, true, now-5*60_000, 0, now); s != "离线（5 分钟前最后心跳） · 已暂停接活" {
		t.Error(s)
	}
	if s := ConnText(ConnPending, false, 0, now+30*60_000, now); s != "待接入（接入码 30 分钟内有效）" {
		t.Error(s)
	}
}

func TestChoose(t *testing.T) {
	yes, no := true, false
	local := Candidate{ID: "h1", Kind: "local", Conn: ConnLocal, Max: 2}
	remote := Candidate{ID: "h2", Kind: "remote", Conn: ConnOnline, Max: 4, Repos: []string{"a/b"},
		CLIs: map[string]CLI{"codex": {Installed: true, LoggedIn: &yes}, "claude": {Installed: true, LoggedIn: &no}}}
	with := func(c Candidate, f func(*Candidate)) Candidate { f(&c); return c }
	codex := Need{Tool: "codex", Repo: "a/b"}
	cases := []struct {
		name   string
		cands  []Candidate
		need   Need
		pinned string
		want   Choice
	}{
		{"一样空本机优先", []Candidate{remote, local}, codex, "", Choice{Kind: "run", Host: "h1"}},
		{"本机更忙挑远程", []Candidate{with(local, func(c *Candidate) { c.Running = 1 }), remote}, codex, "", Choice{Kind: "run", Host: "h2"}},
		{"远程没登记仓库", []Candidate{with(local, func(c *Candidate) { c.Running = 2 }), remote}, Need{Tool: "codex", Repo: "x/y"}, "",
			Choice{Kind: "queue", Reason: "h1 同时最多跑 2 个执行者，有执行者结束后再拉起"}},
		{"远程没登录", []Candidate{with(local, func(c *Candidate) { c.Paused = true }), remote}, Need{Tool: "claude", Repo: "a/b"}, "",
			Choice{Kind: "queue", Reason: "h1 已暂停接活，也没有别的机器能接，有机器能接时再拉起"}},
		{"暂停的不选", []Candidate{local, with(remote, func(c *Candidate) { c.Paused = true })}, codex, "h2", Choice{Kind: "refuse", Reason: "h2 已暂停接活"}},
		{"指定不看仓库", []Candidate{local, remote}, Need{Tool: "codex", Repo: "x/y"}, "h2", Choice{Kind: "run", Host: "h2"}},
		{"指定满了排队钉住", []Candidate{local, with(remote, func(c *Candidate) { c.Running = 4 })}, codex, "h2",
			Choice{Kind: "queue", Host: "h2", Reason: "h2 同时最多跑 4 个执行者，有执行者结束后再拉起"}},
		{"指定不存在", []Candidate{local}, codex, "h9", Choice{Kind: "refuse", Reason: "没有机器 h9"}},
		{"离线", []Candidate{with(remote, func(c *Candidate) { c.Conn = ConnOffline })}, codex, "h2", Choice{Kind: "refuse", Reason: "h2 离线"}},
		{"代理报忙", []Candidate{with(remote, func(c *Candidate) { c.Busy = "负载高" })}, codex, "", Choice{Kind: "queue", Reason: "负载高"}},
		{"紧急的不看满", []Candidate{with(local, func(c *Candidate) { c.Running = 2 }), remote}, Need{Tool: "codex", Repo: "a/b", Urgent: true}, "",
			Choice{Kind: "run", Host: "h2"}},
		{"没装", []Candidate{remote}, Need{Tool: "kimi"}, "h2", Choice{Kind: "refuse", Reason: "h2 上没装 kimi"}},
	}
	for _, c := range cases {
		if got := Choose(c.cands, c.need, c.pinned); got != c.want {
			t.Errorf("%s: %+v，应为 %+v", c.name, got, c.want)
		}
	}
}

func TestLogAcceptAndReconcile(t *testing.T) {
	cases := []struct {
		expected, offset, length, skip int64
		verdict                        string
	}{{10, 10, 5, 0, "append"}, {10, 8, 5, 2, "append"}, {10, 12, 5, 0, "gap"}, {10, 2, 5, 0, "stale"}, {10, 5, 5, 0, "stale"}}
	for _, c := range cases {
		if skip, v := LogAccept(c.expected, c.offset, c.length); skip != c.skip || v != c.verdict {
			t.Errorf("%+v: %d %s", c, skip, v)
		}
	}
	server := []RunRef{{"t1", 1}, {"t2", 2}, {"t3", 1}}
	agent := []AgentRun{{RunRef{"t1", 1}, true}, {RunRef{"t2", 1}, true}, {RunRef{"t4", 1}, false}, {RunRef{"t5", 1}, true}}
	lost, orphans := Reconcile(server, agent)
	if !reflect.DeepEqual(lost, []RunRef{{"t2", 2}, {"t3", 1}}) || !reflect.DeepEqual(orphans, []RunRef{{"t2", 1}, {"t5", 1}}) {
		t.Errorf("lost=%v orphans=%v", lost, orphans)
	}
	if Backoff(0) != 1000 || Backoff(3) != 8000 || Backoff(30) != 15000 || TunnelDelay(10) != 60000 {
		t.Error("退避")
	}
}

func TestValidate(t *testing.T) {
	cases := []struct {
		in            AddInput
		ok            bool
		local, remote int
	}{
		{AddInput{Name: "ggb", Repos: []string{"a/b", "*", "a/b"}}, true, 0, 0},
		{AddInput{Name: " "}, false, 0, 0},
		{AddInput{Name: "x", Repos: []string{"bad"}}, false, 0, 0},
		{AddInput{Name: "x", Max: 65}, false, 0, 0},
		{AddInput{Name: "x", SSH: "me@host"}, true, 4320, 4320},
		{AddInput{Name: "x", SSH: "me@host", Tunnel: "4320:14320"}, true, 4320, 14320},
		{AddInput{Name: "x", SSH: "-oProxyCommand=x"}, false, 0, 0},
		{AddInput{Name: "x", SSH: "me@host", Tunnel: "99999:1"}, false, 0, 0},
		{AddInput{Name: "x", Tunnel: "1:2"}, false, 0, 0},
		{AddInput{Name: "x", SSH: "me@host", Key: "/k/id"}, true, 4320, 4320},
		{AddInput{Name: "x", SSH: "me@host", Key: "id_rsa"}, false, 0, 0},
		{AddInput{Name: "x", Key: "/k/id"}, false, 0, 0},
	}
	for i, c := range cases {
		l, r, err := c.in.Validate(4320)
		if (err == nil) != c.ok || l != c.local || r != c.remote {
			t.Errorf("#%d: %d %d %v", i, l, r, err)
		}
	}
	in := AddInput{Name: "ggb", Repos: []string{"a/b", "*", "a/b"}}
	in.Validate(1)
	if !reflect.DeepEqual(in.Repos, []string{"a/b", "*"}) {
		t.Errorf("去重：%v", in.Repos)
	}
	args := strings.Join(TunnelArgs("me@h", "", 1, 2), " ")
	if !strings.Contains(args, "-R 127.0.0.1:2:127.0.0.1:1 me@h") || !strings.Contains(args, "BatchMode=yes") || strings.Contains(args, "-i") {
		t.Error(args)
	}
	if args := strings.Join(TunnelArgs("me@h", "/k/id", 1, 2), " "); !strings.Contains(args, "-i /k/id -o IdentitiesOnly=yes") {
		t.Error(args)
	}
	for url, want := range map[string]string{"https://github.com/a/b.git": "a-b", "git@github.com:a/b.git": "a-b", "/tmp/x/repo.git/": "x-repo", "": "repo"} {
		if got := CloneName(url); got != want {
			t.Errorf("CloneName(%q)=%q", url, got)
		}
	}
}

func TestAssignmentRefusal(t *testing.T) {
	known := func(s string) bool { return s == "codex" }
	ok := Assignment{Task: "t1", Run: 1, Tool: "codex", Request: workers.Request{Prompt: "做"}, Repo: "https://x/a/b", Branch: "t1-x", Base: "main",
		Env: map[string]string{"MY_KEY": "v"}}
	if r := AssignmentRefusal(ok, known); r != "" {
		t.Fatal(r)
	}
	bad := []func(a *Assignment){
		func(a *Assignment) { a.Task = "../t1" },
		func(a *Assignment) { a.Run = 0 },
		func(a *Assignment) { a.Tool = "rm" },
		func(a *Assignment) { a.Request.Prompt = " " },
		func(a *Assignment) { a.Repo = "--upload-pack=x" },
		func(a *Assignment) { a.Branch = "-x" },
		func(a *Assignment) { a.Base = "a..b" },
		func(a *Assignment) { a.Env = map[string]string{"ATRIUM_WORKER": "0"} },
		func(a *Assignment) { a.Env = map[string]string{"A B": "x"} },
	}
	for i, f := range bad {
		a := ok
		f(&a)
		if AssignmentRefusal(a, known) == "" {
			t.Errorf("#%d 应拒绝", i)
		}
	}
}

func TestInfoHelpers(t *testing.T) {
	has := func(files ...string) func(string) bool {
		return func(r string) bool {
			for _, f := range files {
				if f == r {
					return true
				}
			}
			return false
		}
	}
	str := func(p *bool) string {
		if p == nil {
			return "nil"
		}
		if *p {
			return "yes"
		}
		return "no"
	}
	cases := []struct {
		tool, goos, want string
		exists           func(string) bool
	}{
		{"claude", "darwin", "nil", has()},
		{"claude", "linux", "no", has()},
		{"claude", "linux", "yes", has(".claude.json")},
		{"codex", "windows", "no", has()},
		{"codex", "darwin", "yes", has(".codex/auth.json")},
		{"kimi", "linux", "nil", has()},
	}
	for _, c := range cases {
		if got := str(LoggedIn(c.tool, c.goos, c.exists)); got != c.want {
			t.Errorf("%s/%s: %s", c.tool, c.goos, got)
		}
	}
	if v, ok := ParseLoadavg("{ 1.50 1.2 1.0 }"); !ok || v != 1.5 {
		t.Error("sysctl 格式")
	}
	if v, ok := ParseLoadavg("0.25 0.3 0.1 1/200 3"); !ok || v != 0.25 {
		t.Error("/proc 格式")
	}
	if BusyReason(12, 8) == "" || BusyReason(11, 8) != "" {
		t.Error("BusyReason")
	}
	if MaxWorkers(map[string]string{"ATRIUM_MAX_WORKERS": "3"}, 8) != 3 || MaxWorkers(nil, 1) != 1 || MaxWorkers(nil, 8) != 4 {
		t.Error("MaxWorkers")
	}
}

func TestServiceLayout(t *testing.T) {
	mac, err := ServiceLayout(ServiceInput{GOOS: "darwin", Exe: "/usr/local/bin/atrium", Data: "/Users/a/.atrium-agent", Home: "/Users/a", UID: 501})
	if err != nil {
		t.Fatal(err)
	}
	plist := mac.Files[0].Content
	if mac.Definition != "/Users/a/Library/LaunchAgents/dev.atrium.agent.plist" || mac.Target != "gui/501/dev.atrium.agent" ||
		!strings.Contains(plist, "<string>agent</string>") || !strings.Contains(plist, "<key>SuccessfulExit</key>") ||
		!strings.Contains(plist, "<integer>10</integer>") || strings.Contains(plist, "token") {
		t.Errorf("plist：%s", plist)
	}
	steps := InstallSteps(mac, true)
	if steps[0].Args[0] != "bootout" || steps[2].Args[1] != "gui/501" || steps[2].Retries != 5 {
		t.Errorf("launchd 步骤：%+v", steps)
	}
	linux, err := ServiceLayout(ServiceInput{GOOS: "linux", Exe: "/opt/atrium", Data: "/home/a/%d$x", Home: "/home/a", Env: map[string]string{"XDG_CONFIG_HOME": "relative"}})
	if err != nil {
		t.Fatal(err)
	}
	unit := linux.Files[0].Content
	if linux.Definition != "/home/a/.config/systemd/user/atrium-agent.service" ||
		!strings.Contains(unit, `ExecStart="/opt/atrium" "agent" "--data" "/home/a/%%d$$x"`) ||
		!strings.Contains(unit, "Restart=on-failure") || !strings.Contains(unit, "RestartSec=10") || !strings.Contains(unit, "KillMode=process") {
		t.Errorf("unit：%s", unit)
	}
	win, err := ServiceLayout(ServiceInput{GOOS: "windows", Exe: `C:\atrium\atrium.exe`, Data: `C:\Users\a\.atrium-agent`,
		Env: map[string]string{"USERNAME": "a", "USERDOMAIN": "PC"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(win.Files) != 2 || !win.Files[1].UTF16 || !strings.Contains(win.Files[1].Content, `<UserId>PC\a</UserId>`) ||
		!strings.Contains(win.Files[0].Content, "shell.Run(command, 0, true)") || !strings.Contains(win.Files[1].Content, `C:\Windows\System32\wscript.exe`) {
		t.Errorf("windows：%+v", win.Files)
	}
	if s := InstallSteps(win, false); s[0].Args[0] != "/Create" || s[1].Args[0] != "/Run" {
		t.Errorf("schtasks：%+v", s)
	}
	for _, in := range []ServiceInput{
		{GOOS: "darwin", Exe: "atrium", Data: "/d", UID: 1},
		{GOOS: "darwin", Exe: "/a", Data: "/d"},
		{GOOS: "windows", Exe: `C:\a%b\x.exe`, Data: `C:\d`, Env: map[string]string{"USERNAME": "a"}},
		{GOOS: "windows", Exe: `C:\x.exe`, Data: `C:\d`},
		{GOOS: "linux", Exe: "/a\nb", Data: "/d"},
		{GOOS: "plan9", Exe: "/a", Data: "/d"},
	} {
		if _, err := ServiceLayout(in); err == nil {
			t.Errorf("应拒绝：%+v", in)
		}
	}
	if s := ParseStatus("darwin", true, "\tstate = running\n\tpid = 42\n"); !s.Installed || !s.Running || s.PID != 42 {
		t.Errorf("%+v", s)
	}
	if s := ParseStatus("darwin", false, ""); s.Installed {
		t.Error("没装")
	}
	if s := ParseStatus("linux", true, "LoadState=loaded\nActiveState=active\nMainPID=7\n"); !s.Running || s.PID != 7 {
		t.Errorf("%+v", s)
	}
	if s := ParseStatus("linux", true, "LoadState=not-found\n"); s.Installed {
		t.Error("not-found 应为没装")
	}
	b := utf16File("A中")
	if b[0] != 0xFF || b[1] != 0xFE || len(b) != 2+2*len(utf16.Encode([]rune("A中"))) {
		t.Error("UTF-16")
	}
	env := CarriedEnv("windows", map[string]string{"Path": "x", "OPENAI_API_KEY": "k", "LC_ALL": "c", "https_proxy": "p"})
	if env["PATH"] != "x" || env["OPENAI_API_KEY"] != "" || env["LC_ALL"] != "c" {
		t.Errorf("%v", env)
	}
}

func TestEditPlan(t *testing.T) {
	h := Host{Name: "ggb", Repos: []string{"*"}, MaxRunning: 2, SSH: "me@g", Key: "/k/id", TunnelRemote: 14310}
	str := func(s string) *string { return &s }
	cases := []struct {
		name string
		e    EditInput
		want AddInput
	}{
		{"不改：导入的旧机器本机端口按服务端口", EditInput{}, AddInput{Name: "ggb", Repos: []string{"*"}, Max: 2, SSH: "me@g", Key: "/k/id", Tunnel: "4320:14310"}},
		{"换私钥", EditInput{Key: str("/k/new")}, AddInput{Name: "ggb", Repos: []string{"*"}, Max: 2, SSH: "me@g", Key: "/k/new", Tunnel: "4320:14310"}},
		{"去掉隧道连同私钥", EditInput{SSH: str("")}, AddInput{Name: "ggb", Repos: []string{"*"}, Max: 2}},
	}
	for _, c := range cases {
		if got := EditPlan(h, c.e, 4320); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s：%+v", c.name, got)
		}
	}
}
