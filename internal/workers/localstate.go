package workers

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/platform"
)

// excludeLocalState 只作用于拉起目录的 linked worktree。不能用 info/exclude：
// linked worktree 的该文件属于 common git dir，会同时改变用户主检出的忽略规则。
// 已有同名文件不认领；只排除 adapter 明确声明、拉起前尚不存在的自动生成文件。
func (l Launch) excludeLocalState() error {
	if len(l.LocalState) == 0 || l.Dir == "" {
		return nil
	}
	fi, err := os.Lstat(filepath.Join(l.Dir, ".git"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return nil
	}
	git := func(args ...string) (string, error) {
		env := platform.WorkerEnv(runtime.GOOS, platform.EnvMap(os.Environ()))
		exe, err := platform.LookPath("git", env)
		if err != nil {
			return "", err
		}
		var out, stderr bytes.Buffer
		cmd, err := platform.Start(platform.Spec{Path: exe, Args: args, Dir: l.Dir, Env: env, Stdout: &out, Stderr: &stderr})
		if err != nil {
			return "", err
		}
		if err = cmd.Wait(); err != nil {
			return "", fmt.Errorf("git %v: %w: %s", args, err, stderr.String())
		}
		return strings.TrimSpace(out.String()), nil
	}
	gd, err := git("rev-parse", "--absolute-git-dir")
	if err != nil {
		return err
	}
	path := filepath.Join(gd, "atrium-exclude")
	// 已准备的工作树保留认领范围；续接时不能把执行者新增的未知文件变成忽略文件。
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	var rules []string
	for _, name := range l.LocalState {
		if _, err := os.Lstat(filepath.Join(l.Dir, name)); os.IsNotExist(err) {
			rules = append(rules, "/"+filepath.ToSlash(name))
		} else if err != nil {
			return err
		}
	}
	if len(rules) == 0 {
		return nil
	}
	// 保留当前用户的忽略规则；只给当前工作树追加精确文件名。
	prior, err := git("config", "--path", "--default", "", "--get", "core.excludesFile")
	if err != nil {
		return err
	}
	if prior == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		configHome := os.Getenv("XDG_CONFIG_HOME")
		if configHome == "" {
			configHome = filepath.Join(home, ".config")
		}
		prior = filepath.Join(configHome, "git", "ignore")
	}
	var inherited []byte
	if prior != "" {
		if !filepath.IsAbs(prior) {
			prior = filepath.Join(l.Dir, prior)
		}
		inherited, err = os.ReadFile(prior)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if _, err := git("config", "extensions.worktreeConfig", "true"); err != nil {
		return err
	}
	if err := os.WriteFile(path, append(inherited, []byte("\n"+strings.Join(rules, "\n")+"\n")...), 0o600); err != nil {
		return err
	}
	_, err = git("config", "--worktree", "core.excludesFile", path)
	return err
}
