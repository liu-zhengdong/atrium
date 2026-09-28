package hosts

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/liu-zhengdong/atrium/internal/platform"
)

// 代理装成系统服务：写哪些文件、跑哪些系统命令、怎么读状态是这里的纯函数（三平台穷举测试）；IO 在 InstallAgent 等。
// - macOS：launchd 用户代理 ~/Library/LaunchAgents/dev.atrium.agent.plist（登录时启动，非 0 退出 10 秒后重起）。
// - Linux：systemd 用户服务 ~/.config/systemd/user/atrium-agent.service（Restart=on-failure，RestartSec=10，KillMode=process：停代理不停执行者）。
// - Windows：计划任务 AtriumAgent，本人登录时启动；经 wscript 跑 JScript 以隐藏窗口拉起，非 0 退出 10 秒后重来。
// 服务定义里只有命令行（atrium agent --data 数据目录），不写令牌与环境值：都在数据目录 agent.json（0600）里。
// 令牌失效时代理以 0 退出，系统不再重起它。

const (
	launchdLabel = "dev.atrium.agent"
	systemdUnit  = "atrium-agent.service"
	windowsTask  = "AtriumAgent"
	restartSec   = 10
)

// carried 是装成服务时要带上的环境：出得了网、找得到编码 CLI、守同样的并发上限。
var carried = map[string]bool{"PATH": true, "LANG": true, "TZ": true, "HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true,
	"ALL_PROXY": true, "http_proxy": true, "https_proxy": true, "no_proxy": true, "all_proxy": true, "SSL_CERT_FILE": true,
	"ATRIUM_MAX_WORKERS": true, "ATRIUM_QUOTA_READERS": true}

// CarriedEnv 取白名单里的环境（Windows 上变量名按大写）。
func CarriedEnv(goos string, env map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range env {
		name := platform.EnvKey(goos, k)
		if v != "" && (carried[name] || strings.HasPrefix(name, "LC_")) {
			out[name] = v
		}
	}
	return out
}

// ServiceInput 是生成服务定义的输入。
type ServiceInput struct {
	GOOS string
	Exe  string // atrium 可执行文件绝对路径
	Data string // 代理数据目录
	Home string
	Env  map[string]string // 取 XDG_CONFIG_HOME、USERNAME、USERDOMAIN、SYSTEMROOT
	UID  int               // macOS：launchctl 的 gui/<uid> 域
}

// ServiceFile 是要写的一个文件；UTF16 用于 Windows 计划任务 XML（schtasks /XML 认 UTF-16）。
type ServiceFile struct {
	Path    string
	Content string
	UTF16   bool
}

// Layout 是一台的服务定义。
type Layout struct {
	GOOS       string
	Name       string // launchd 标签、systemd 单元名或计划任务名
	Target     string // launchctl 的 gui/<uid>/<标签>
	Definition string
	Files      []ServiceFile
	Log        string
	Program    []string
}

// Step 是一条系统命令；AllowFail 失败也往下走，Retries 失败时隔一秒再试。
type Step struct {
	Command   string
	Args      []string
	AllowFail bool
	Retries   int
}

func joinOS(goos string, parts ...string) string {
	if goos != "windows" {
		return path.Join(parts...)
	}
	return strings.Join(parts, `\`)
}

func absOS(goos, p string) bool {
	if goos == "windows" {
		return regexp.MustCompile(`^[A-Za-z]:\\`).MatchString(p)
	}
	return strings.HasPrefix(p, "/")
}

func xmlEsc(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

// systemdQuote：反斜杠与引号转义，% 与 $ 写两遍。
func systemdQuote(s string) string {
	s = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%", "$", "$$").Replace(s)
	return `"` + s + `"`
}

// ServiceLayout 生成这台要写的服务文件与命令行（纯函数）；参数装不进服务定义时报错。
func ServiceLayout(in ServiceInput) (Layout, error) {
	for _, v := range [][2]string{{"atrium 路径", in.Exe}, {"代理数据目录", in.Data}} {
		if !absOS(in.GOOS, v[1]) {
			return Layout{}, fmt.Errorf("%s应为绝对路径（收到：%s）", v[0], v[1])
		}
		if strings.ContainsAny(v[1], "\r\n\x00") {
			return Layout{}, fmt.Errorf("%s里有换行或空字符", v[0])
		}
		if in.GOOS == "windows" && strings.ContainsAny(v[1], `"%`) {
			return Layout{}, fmt.Errorf("%s里有 \" 或 %%，Windows 计划任务经 cmd.exe 拉起时装不进去：%s", v[0], v[1])
		}
	}
	prog := []string{in.Exe, "agent", "--data", in.Data}
	log := joinOS(in.GOOS, in.Data, "agent-service.log")
	l := Layout{GOOS: in.GOOS, Log: log, Program: prog}
	switch in.GOOS {
	case "darwin":
		if in.UID <= 0 {
			return Layout{}, fmt.Errorf("取不到当前用户 id，装不了 launchd 用户代理")
		}
		l.Name, l.Target = launchdLabel, fmt.Sprintf("gui/%d/%s", in.UID, launchdLabel)
		l.Definition = joinOS(in.GOOS, in.Home, "Library", "LaunchAgents", launchdLabel+".plist")
		var args strings.Builder
		for _, a := range prog {
			fmt.Fprintf(&args, "    <string>%s</string>\n", xmlEsc(a))
		}
		l.Files = []ServiceFile{{Path: l.Definition, Content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Atrium 代理：atrium agent install 生成，卸载用 atrium agent install --uninstall -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + launchdLabel + `</string>
  <key>ProgramArguments</key>
  <array>
` + args.String() + `  </array>
  <key>WorkingDirectory</key>
  <string>` + xmlEsc(in.Data) + `</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>` + strconv.Itoa(restartSec) + `</integer>
  <key>StandardOutPath</key>
  <string>` + xmlEsc(log) + `</string>
  <key>StandardErrorPath</key>
  <string>` + xmlEsc(log) + `</string>
</dict>
</plist>
`}}
	case "linux":
		cfg := strings.TrimSpace(in.Env["XDG_CONFIG_HOME"])
		if !absOS(in.GOOS, cfg) {
			cfg = joinOS(in.GOOS, in.Home, ".config")
		}
		l.Name = systemdUnit
		l.Definition = joinOS(in.GOOS, cfg, "systemd", "user", systemdUnit)
		var q []string
		for _, a := range prog {
			q = append(q, systemdQuote(a))
		}
		esc := func(s string) string { return strings.ReplaceAll(s, "%", "%%") }
		l.Files = []ServiceFile{{Path: l.Definition, Content: strings.Join([]string{
			"# Atrium 代理：atrium agent install 生成，卸载用 atrium agent install --uninstall",
			"[Unit]", "Description=Atrium agent", "StartLimitIntervalSec=0", "",
			"[Service]", "Type=simple",
			"ExecStart=" + strings.Join(q, " "),
			"WorkingDirectory=" + esc(in.Data),
			"Restart=on-failure", "RestartSec=" + strconv.Itoa(restartSec),
			"KillMode=process",
			"StandardOutput=append:" + esc(log), "StandardError=append:" + esc(log), "",
			"[Install]", "WantedBy=default.target", ""}, "\n")}}
	case "windows":
		user := strings.TrimSpace(in.Env["USERNAME"])
		if user == "" {
			return Layout{}, fmt.Errorf("取不到 USERNAME，装不了只在本人登录时启动的计划任务")
		}
		if d := strings.TrimSpace(in.Env["USERDOMAIN"]); d != "" {
			user = d + `\` + user
		}
		root := strings.TrimSpace(in.Env["SYSTEMROOT"])
		if root == "" {
			root = `C:\Windows`
		}
		launcher := joinOS(in.GOOS, in.Data, "agent-service.js")
		l.Name, l.Definition = windowsTask, joinOS(in.GOOS, in.Data, "agent-service.xml")
		var quoted []string
		for _, a := range prog {
			quoted = append(quoted, `"`+a+`"`)
		}
		line := strings.Join(quoted, " ") + ` >> "` + log + `" 2>&1`
		command, _ := json.Marshal(`cmd.exe /d /s /c "` + line + `"`)
		js := strings.Join([]string{
			"// Atrium 代理：atrium agent install 生成，卸载用 atrium agent install --uninstall",
			"// 以隐藏窗口拉起代理；非 0 退出隔一会儿重来，令牌失效（以 0 退出）或本文件已删（卸载）就停。",
			`var shell = new ActiveXObject("WScript.Shell");`,
			`var files = new ActiveXObject("Scripting.FileSystemObject");`,
			"var command = " + string(command) + ";",
			"while (true) {",
			"  var code = shell.Run(command, 0, true);",
			"  if (code === 0) break;",
			"  WScript.Sleep(" + strconv.Itoa(restartSec*1000) + ");",
			"  if (!files.FileExists(WScript.ScriptFullName)) break;",
			"}", ""}, "\r\n")
		task := strings.Join([]string{
			`<?xml version="1.0" encoding="UTF-16"?>`,
			`<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
			`  <RegistrationInfo><Description>Atrium 代理：atrium agent install 生成</Description></RegistrationInfo>`,
			`  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>` + xmlEsc(user) + `</UserId></LogonTrigger></Triggers>`,
			`  <Principals><Principal id="Author"><UserId>` + xmlEsc(user) + `</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
			`  <Settings>`,
			`    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
			`    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
			`    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
			`    <StartWhenAvailable>true</StartWhenAvailable>`,
			`    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
			`    <Priority>5</Priority>`,
			`  </Settings>`,
			`  <Actions Context="Author"><Exec>`,
			`    <Command>` + xmlEsc(joinOS(in.GOOS, root, "System32", "wscript.exe")) + `</Command>`,
			`    <Arguments>` + xmlEsc(`//B //Nologo //E:JScript "`+launcher+`"`) + `</Arguments>`,
			`    <WorkingDirectory>` + xmlEsc(in.Data) + `</WorkingDirectory>`,
			`  </Exec></Actions>`,
			`</Task>`, ""}, "\r\n")
		l.Files = []ServiceFile{{Path: launcher, Content: js}, {Path: l.Definition, Content: task, UTF16: true}}
	default:
		return Layout{}, fmt.Errorf("%s 上不支持装成系统服务；前台跑 atrium agent", in.GOOS)
	}
	return l, nil
}

// StatusQuery 是查服务状态的命令（只看退出码与少数字段，输出随系统语言变）。
func StatusQuery(l Layout) Step {
	switch l.GOOS {
	case "darwin":
		return Step{Command: "launchctl", Args: []string{"print", l.Target}}
	case "linux":
		return Step{Command: "systemctl", Args: []string{"--user", "show", l.Name, "--property=LoadState,ActiveState,MainPID,UnitFileState"}}
	}
	return Step{Command: "schtasks", Args: []string{"/Query", "/TN", l.Name}}
}

// ServiceState 是系统里这个服务的状态。
type ServiceState struct {
	Installed bool `json:"installed"`
	Running   bool `json:"running"`
	PID       int  `json:"pid,omitempty"`
}

// ParseStatus 解析 StatusQuery 的结果（纯函数）。Windows 查询不给在不在跑，由 agent.pid 判。
func ParseStatus(goos string, ok bool, out string) ServiceState {
	switch goos {
	case "darwin":
		if !ok {
			return ServiceState{}
		}
		s := ServiceState{Installed: true, Running: regexp.MustCompile(`(?m)^\s*state = running\s*$`).MatchString(out)}
		if m := regexp.MustCompile(`(?m)^\s*pid = ([0-9]+)\s*$`).FindStringSubmatch(out); s.Running && m != nil {
			s.PID, _ = strconv.Atoi(m[1])
		}
		return s
	case "linux":
		f := map[string]string{}
		for _, line := range strings.Split(out, "\n") {
			if k, v, ok := strings.Cut(strings.TrimSpace(line), "="); ok {
				f[k] = v
			}
		}
		s := ServiceState{Installed: ok && f["LoadState"] != "" && f["LoadState"] != "not-found"}
		s.Running = s.Installed && f["ActiveState"] == "active"
		if s.Running {
			s.PID, _ = strconv.Atoi(f["MainPID"])
		}
		return s
	}
	return ServiceState{Installed: ok}
}

// InstallSteps 是文件写好后要跑的命令；已登记过的先停再按新定义起（旧代理停下不带走执行者）。
func InstallSteps(l Layout, installed bool) []Step {
	switch l.GOOS {
	case "darwin":
		domain := l.Target[:strings.LastIndex(l.Target, "/")]
		var s []Step
		if installed {
			s = append(s, Step{Command: "launchctl", Args: []string{"bootout", l.Target}, AllowFail: true})
		}
		return append(s,
			Step{Command: "launchctl", Args: []string{"enable", l.Target}, AllowFail: true},
			Step{Command: "launchctl", Args: []string{"bootstrap", domain, l.Definition}, Retries: 5})
	case "linux":
		return []Step{
			{Command: "systemctl", Args: []string{"--user", "daemon-reload"}},
			{Command: "systemctl", Args: []string{"--user", "enable", l.Name}},
			{Command: "systemctl", Args: []string{"--user", "restart", l.Name}},
		}
	}
	var s []Step
	if installed {
		s = append(s, Step{Command: "schtasks", Args: []string{"/End", "/TN", l.Name}, AllowFail: true})
	}
	return append(s,
		Step{Command: "schtasks", Args: []string{"/Create", "/TN", l.Name, "/XML", l.Definition, "/F"}},
		Step{Command: "schtasks", Args: []string{"/Run", "/TN", l.Name}})
}

// UninstallSteps 是卸载要跑的命令（之后删服务文件）；没装的步骤失败也不要紧。agent.json 留着，下次再装。
func UninstallSteps(l Layout) []Step {
	switch l.GOOS {
	case "darwin":
		return []Step{{Command: "launchctl", Args: []string{"bootout", l.Target}, AllowFail: true}}
	case "linux":
		return []Step{{Command: "systemctl", Args: []string{"--user", "disable", "--now", l.Name}, AllowFail: true}}
	}
	return []Step{
		{Command: "schtasks", Args: []string{"/End", "/TN", l.Name}, AllowFail: true},
		{Command: "schtasks", Args: []string{"/Delete", "/TN", l.Name, "/F"}, AllowFail: true},
	}
}

// ---- IO ----

func utf16File(s string) []byte {
	var b bytes.Buffer
	b.Write([]byte{0xFF, 0xFE})
	for _, u := range utf16.Encode([]rune(s)) {
		binary.Write(&b, binary.LittleEndian, u)
	}
	return b.Bytes()
}

// runStep 跑一条系统命令，返回是否成功与输出。
func runStep(s Step, env map[string]string) (bool, string, error) {
	p, err := platform.LookPath(s.Command, env)
	if err != nil {
		return false, "", err
	}
	var out bytes.Buffer
	cmd, err := platform.Start(platform.Spec{Path: p, Args: s.Args, Env: env, Stdout: &out, Stderr: &out})
	if err != nil {
		return false, "", err
	}
	err = cmd.Wait()
	return err == nil, out.String(), nil
}

// InstallReport 是 agent install 的回执。
type InstallReport struct {
	Action string       `json:"action"` // installed、uninstalled、status
	Name   string       `json:"name"`
	Files  []string     `json:"files"`
	Log    string       `json:"log"`
	State  ServiceState `json:"state"`
}

// ManageService 装、卸或查代理的系统服务。
func ManageService(in ServiceInput, action string) (InstallReport, error) {
	l, err := ServiceLayout(in)
	if err != nil {
		return InstallReport{}, err
	}
	env, _ := platform.ServiceEnv(in.GOOS, in.Env)
	rep := InstallReport{Action: action, Name: l.Name, Log: l.Log}
	for _, f := range l.Files {
		rep.Files = append(rep.Files, f.Path)
	}
	status := func() ServiceState {
		ok, out, err := runStep(StatusQuery(l), env)
		return ParseStatus(in.GOOS, ok && err == nil, out)
	}
	run := func(steps []Step) error {
		for _, s := range steps {
			for try := 0; ; try++ {
				ok, out, err := runStep(s, env)
				if err == nil && ok {
					break
				}
				if s.AllowFail {
					break
				}
				if try < s.Retries {
					time.Sleep(time.Second)
					continue
				}
				if err == nil {
					err = fmt.Errorf("%s", strings.TrimSpace(out))
				}
				return fmt.Errorf("%s %s 失败：%v", s.Command, strings.Join(s.Args, " "), err)
			}
		}
		return nil
	}
	switch action {
	case "status":
	case "install":
		before := status()
		for _, f := range l.Files {
			if err := os.MkdirAll(filepath.Dir(f.Path), 0o700); err != nil {
				return rep, err
			}
			content := []byte(f.Content)
			if f.UTF16 {
				content = utf16File(f.Content)
			}
			if err := os.WriteFile(f.Path, content, 0o600); err != nil {
				return rep, err
			}
		}
		if err := run(InstallSteps(l, before.Installed)); err != nil {
			return rep, err
		}
	case "uninstall":
		if err := run(UninstallSteps(l)); err != nil {
			return rep, err
		}
		for _, f := range l.Files {
			if err := os.Remove(f.Path); err != nil && !os.IsNotExist(err) {
				return rep, err
			}
		}
		if in.GOOS == "linux" {
			run([]Step{{Command: "systemctl", Args: []string{"--user", "daemon-reload"}, AllowFail: true}})
		}
	}
	rep.State = status()
	return rep, nil
}
