package platform

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Spec 描述一个要拉起的子进程。Env 必须显式给（来自 ServiceEnv 或 WorkerEnv），不继承当前进程环境。
type Spec struct {
	Path   string   // 可执行文件的绝对路径（先 LookPath）
	Args   []string // 不含程序名
	Dir    string
	Env    map[string]string
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
	// Detached：放进独立会话/进程组，父进程退出或重启不影响它，结束时按整棵树结束。
	Detached bool
}

// EnvMap 把 os.Environ() 形式转成 map（Windows 上变量名按大写）。
func EnvMap(list []string) map[string]string { return envMap(runtime.GOOS, list) }

// Start 拉起子进程；Windows 上 .cmd/.bat（如 npm 装的 claude.cmd）经 cmd.exe 拉起。调用方负责 Wait（Unix 上不 Wait 会留下僵尸，Alive 会一直报活着）。
func Start(s Spec) (*exec.Cmd, error) {
	if s.Env == nil {
		return nil, errors.New("platform.Start：必须显式给 Env（白名单环境）")
	}
	cmd, cmdLine := exec.Command(s.Path, s.Args...), ""
	if IsBatch(runtime.GOOS, s.Path) {
		comspec := s.Env[EnvKey(runtime.GOOS, "COMSPEC")]
		line, err := BatchCommandLine(comspec, s.Path, s.Args)
		if err != nil {
			return nil, err
		}
		cmd, cmdLine = exec.Command(ShellInvocation(runtime.GOOS, "", comspec).Command), line
	}
	cmd.Dir = s.Dir
	cmd.Env = EnvList(s.Env)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = s.Stdin, s.Stdout, s.Stderr
	cmd.SysProcAttr = sysProcAttr(s.Detached, cmdLine)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}

// Shell 生成跑一条 shell 命令的 Spec（其余字段调用方补）。
func Shell(command string) Spec {
	inv := ShellInvocation(runtime.GOOS, command, os.Getenv("COMSPEC"))
	return Spec{Path: inv.Command, Args: inv.Args}
}

// Script 生成跑仓库 shell 脚本的 Spec（Env 一并填上，其余字段调用方补）。Windows 上在 env 的 PATH 里找
// Git for Windows 的 sh.exe／bash.exe，找不到就报错说清要装什么。
func Script(script string, env map[string]string) (Spec, error) {
	sh := ""
	if names := ScriptShells(runtime.GOOS); len(names) > 0 {
		for _, n := range names {
			if p, err := LookPath(n, env); err == nil {
				sh = p
				break
			}
		}
		if sh == "" {
			return Spec{}, fmt.Errorf("跑 %s 要 sh：PATH 上找不到 sh.exe 或 bash.exe；装 Git for Windows，并把它的 bin 目录（如 C:\\Program Files\\Git\\bin）加进 PATH", filepath.Base(script))
		}
	}
	inv := ScriptInvocation(runtime.GOOS, script, sh)
	return Spec{Path: inv.Command, Args: inv.Args, Env: env}, nil
}

// LookPath 在给定的 PATH（通常取自子进程的白名单环境）里找可执行文件。
func LookPath(name string, env map[string]string) (string, error) {
	if strings.ContainsRune(name, filepath.Separator) || strings.ContainsRune(name, '/') {
		if isExecutable(name) {
			return name, nil
		}
		return "", fmt.Errorf("%s 不存在或不可执行", name)
	}
	pathEnv := env[EnvKey(runtime.GOOS, "PATH")]
	names := ExecutableNames(runtime.GOOS, name, env[EnvKey(runtime.GOOS, "PATHEXT")])
	for _, dir := range strings.Split(pathEnv, PathListSeparator(runtime.GOOS)) {
		if dir == "" {
			continue
		}
		for _, n := range names {
			p := filepath.Join(dir, n)
			if isExecutable(p) {
				return p, nil
			}
		}
	}
	return "", fmt.Errorf("在 PATH 里找不到 %s", name)
}

// KillTree 强制结束 pid 及其整棵子进程树（进程须以 Detached 拉起）。
func KillTree(pid int) error {
	if inv, ok := KillTreeInvocation(runtime.GOOS, pid); ok {
		out, err := exec.Command(inv.Command, inv.Args...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("%s：%w：%s", inv.Command, err, strings.TrimSpace(string(out)))
		}
		return nil
	}
	return killGroup(pid)
}

// Alive 判断进程是否还在。
func Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return alive(pid)
}
