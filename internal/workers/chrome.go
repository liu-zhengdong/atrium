package workers

import (
	"io"
	"os"
	"path/filepath"

	"github.com/liu-zhengdong/atrium/internal/platform"
)

// reserveChrome 在 MCP 入口抢占，避免 Build 做 IO，也覆盖本机、远程与负责人。
// 常数成本：每台机器一个锁文件、专用会话一个文件描述符；不记录 pid、不轮询、不删锁文件。
func reserveChrome(home string) (*os.File, bool, error) {
	profile := filepath.Join(home, ".cache", "chrome-devtools-mcp", "chrome-profile")
	if err := os.MkdirAll(filepath.Dir(profile), 0700); err != nil {
		return nil, false, err
	}
	lock, err := platform.TryFileLock(profile + ".atrium-lock")
	if err != nil || lock == nil {
		return nil, true, err
	}
	busy, err := platform.ChromeProfileBusy(profile)
	if err != nil || busy {
		lock.Close()
		return nil, busy, err
	}
	return lock, false, nil
}

func chromeArgs(isolated bool, extra []string) []string {
	args := []string{"-y", "chrome-devtools-mcp@latest", "--no-usage-statistics"}
	if isolated {
		args = append(args, "--isolated")
	}
	return append(args, extra...)
}

func runChromeMCP(extra []string, stdin io.Reader, stdout, stderr io.Writer) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	lock, isolated, err := reserveChrome(home)
	if err != nil {
		return err
	}
	if lock != nil {
		defer lock.Close()
	}
	// MCP 的临时目录在执行者 TMPDIR 之下；自身退出和执行者退出两条既有回收路径都能找到 Chrome。
	tmp, err := os.MkdirTemp(os.TempDir(), "chrome-mcp-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	env := platform.EnvMap(os.Environ())
	for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
		env[key] = tmp
	}
	exe, err := platform.LookPath("npx", env)
	if err != nil {
		return err
	}
	cmd, err := platform.Start(platform.Spec{Path: exe, Args: chromeArgs(isolated, extra), Env: env, Stdin: stdin, Stdout: stdout, Stderr: stderr, Detached: true})
	if err != nil {
		return err
	}
	return platform.WaitSession(cmd, tmp)
}
