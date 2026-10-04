package workers_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/gates/fakegh"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

func stateRepo(t *testing.T) (*fakegh.GH, string, string) {
	t.Helper()
	home := t.TempDir()
	for _, key := range []string{"HOME", "USERPROFILE", "XDG_CONFIG_HOME"} {
		t.Setenv(key, home)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	gh := fakegh.New(t, map[string]string{"code.go": "package sample\n"})
	wt := filepath.Join(t.TempDir(), "repo")
	gh.Must(gh.Work, "worktree", "add", "--quiet", "-b", "task-t1", wt, "main")
	prompt := filepath.Join(t.TempDir(), "prompt.md")
	if err := os.WriteFile(prompt, []byte("test"), 0o600); err != nil {
		t.Fatal(err)
	}
	return gh, wt, prompt
}

// 两个支持的 adapter 经真实 Build/WriteFiles + 真子进程创建状态。
// 工具是测试二进制本身，不读登录、不调用模型；Pi 只按 adapter 的 --session-dir 写。
func TestAdapterStateDelivery(t *testing.T) {
	for _, tool := range []string{"command-code", "pi"} {
		t.Run(tool, func(t *testing.T) {
			gh, wt, prompt := stateRepo(t)
			launch, err := workers.Build(tool, workers.Request{Dir: wt, PromptFile: prompt, Prompt: "test"})
			if err != nil {
				t.Fatal(err)
			}
			if err := launch.WriteFiles(); err != nil {
				t.Fatal(err)
			}
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			env := platform.WorkerEnv(runtime.GOOS, platform.EnvMap(os.Environ()))
			env["ATRIUM_STATE_TEST"] = tool
			cmd, err := platform.Start(platform.Spec{Path: exe, Args: append([]string{"-test.run=^TestStateToolProcess$", "--"}, launch.Args...), Dir: wt, Env: env, Stdout: os.Stdout, Stderr: os.Stderr})
			if err != nil {
				t.Fatal(err)
			}
			if err := cmd.Wait(); err != nil {
				t.Fatal(err)
			}
			if tool == "pi" {
				if _, err := os.Stat(filepath.Join(filepath.Dir(prompt), "pi-sessions", "session.jsonl")); err != nil {
					t.Fatal(err)
				}
				if _, err := os.Stat(filepath.Join(wt, ".pi")); !os.IsNotExist(err) {
					t.Fatalf("pi 状态落入工作树：%v", err)
				}
			}
			gh.Write(wt, "code.go", "package sample\n// delivered\n")
			gh.Must(wt, "add", "-A")
			gh.Must(wt, "commit", "--quiet", "-m", "代码交付")
			gh.Must(wt, "push", "--quiet", "origin", "task-t1")
			check := func(want bool) {
				t.Helper()
				f, err := gates.Collect(context.Background(), gh, wt, gh.Repo)
				if err != nil {
					t.Fatal(err)
				}
				v := gates.Judge([]string{gates.CheckFinished}, f)
				if v.Pass != want {
					t.Fatalf("gate pass=%v want=%v dirty=%v reasons=%v", v.Pass, want, f.Dirty, v.Reasons)
				}
			}
			check(true)
			if files := gh.Must(wt, "show", "--format=", "--name-only", "HEAD"); files != "code.go" {
				t.Fatalf("提交混入状态：%s", files)
			}
			for _, name := range []string{"code.go", "unknown.txt", ".pi/settings.json", ".commandcode/skills/user.md", ".commandcode/taste/unknown.md"} {
				gh.Write(wt, name, "用户内容\n")
				check(false)
				if name == "code.go" {
					gh.Must(wt, "restore", name)
				} else {
					if err := os.Remove(filepath.Join(wt, name)); err != nil {
						t.Fatal(err)
					}
				}
			}
			// 续接不扩大认领范围，tracked 的同名文件仍会挡住交付。
			if err := launch.WriteFiles(); err != nil {
				t.Fatal(err)
			}
			if tool == "command-code" {
				gh.Must(wt, "add", "-f", ".commandcode/taste/taste.md")
				gh.Must(wt, "commit", "--quiet", "-m", "用户选择交付 taste")
				gh.Must(wt, "push", "--quiet", "origin", "task-t1")
				gh.Write(wt, ".commandcode/taste/taste.md", "用户修改\n")
				check(false)
				gh.Write(gh.Work, ".commandcode/taste/taste.md", "主检出用户内容\n")
				if status := gh.Must(gh.Work, "status", "--porcelain"); !strings.Contains(status, ".commandcode/") {
					t.Fatalf("主检出被忽略：%s", status)
				}
			}
		})
	}
}

func TestStateToolProcess(t *testing.T) {
	tool := os.Getenv("ATRIUM_STATE_TEST")
	if tool == "" {
		return
	}
	var path string
	switch tool {
	case "command-code":
		path = ".commandcode/taste/taste.md"
	case "pi":
		for i, arg := range os.Args {
			if arg == "--session-dir" && i+1 < len(os.Args) {
				path = filepath.Join(os.Args[i+1], "session.jsonl")
			}
		}
		if path == "" {
			os.Exit(3)
		}
	default:
		os.Exit(4)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		os.Exit(5)
	}
	if err := os.WriteFile(path, []byte("local state\n"), 0o600); err != nil {
		os.Exit(6)
	}
	os.Exit(0)
}

func TestLocalStateDoesNotClaimExistingFile(t *testing.T) {
	gh, wt, prompt := stateRepo(t)
	gh.Write(wt, ".commandcode/taste/taste.md", "用户已有内容\n")
	launch, err := workers.Build("command-code", workers.Request{Dir: wt, PromptFile: prompt, Prompt: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if err := launch.WriteFiles(); err != nil {
		t.Fatal(err)
	}
	if status := gh.Must(wt, "status", "--porcelain"); !strings.Contains(status, ".commandcode/") {
		t.Fatalf("用户已有内容被忽略：%s", status)
	}
	if content, err := os.ReadFile(filepath.Join(wt, ".commandcode/taste/taste.md")); err != nil || string(content) != "用户已有内容\n" {
		t.Fatalf("用户已有内容被修改：%q %v", content, err)
	}
}

func TestLocalStatePreservesExcludesAndOtherWorktrees(t *testing.T) {
	gh, wt, prompt := stateRepo(t)
	prior := filepath.Join(t.TempDir(), "ignore")
	if err := os.WriteFile(prior, []byte("/user-cache\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	gh.Must(gh.Work, "config", "core.excludesFile", prior)
	other := filepath.Join(t.TempDir(), "other")
	gh.Must(gh.Work, "worktree", "add", "--quiet", "-b", "other", other, "main")
	launch, err := workers.Build("command-code", workers.Request{Dir: wt, PromptFile: prompt, Prompt: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if err := launch.WriteFiles(); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{wt, gh.Work, other} {
		gh.Write(dir, "user-cache", "cache")
		gh.Write(dir, ".commandcode/taste/taste.md", "state")
		status := gh.Must(dir, "status", "--porcelain")
		if strings.Contains(status, "user-cache") || strings.Contains(status, ".commandcode/") != (dir != wt) {
			t.Fatalf("工作树 %s 忽略范围错误：%s", dir, status)
		}
	}
	if data, err := os.ReadFile(prior); err != nil || string(data) != "/user-cache\n" {
		t.Fatalf("原忽略文件被修改：%q %v", data, err)
	}
}
