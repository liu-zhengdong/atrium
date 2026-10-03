package gates_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
)

// 用测试二进制代替外部工具：仍经真实 Exec 捕获 stderr 和非零退出，不依赖 shell 或浏览器。
func TestStderrCommandHelper(t *testing.T) {
	path := os.Getenv("ATRIUM_TEST_STDERR_FILE")
	if path == "" {
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprint(os.Stdout, "stdout-kept-separate")
	os.Stderr.Write(b)
	os.Exit(7)
}

type stderrCommand struct {
	t          *testing.T
	x          *gates.Exec
	executable string
	stderr     string
}

func (r stderrCommand) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	r.t.Helper()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := r.x.Run(ctx, dir, r.executable, "-test.run=^TestStderrCommandHelper$")
	var cmdErr *gates.CmdError
	var exit *exec.ExitError
	if !errors.As(err, &cmdErr) || !errors.As(err, &exit) || exit.ExitCode() != 7 {
		r.t.Fatalf("应保留真实退出码与错误链：%v", err)
	}
	if out != "stdout-kept-separate" || cmdErr.Stderr != r.stderr {
		r.t.Fatal("Exec 必须分别返回完整 stdout 与原始 stderr")
	}
	return out, err
}

func TestCmdErrorInSkillHistory(t *testing.T) {
	const root = "FATAL: No usable sandbox!"
	const detail = "ERROR: command stopped"
	for _, atStart := range []bool{true, false} {
		t.Run(fmt.Sprintf("root-at-start=%v", atStart), func(t *testing.T) {
			e := setup(t)
			e.g.Data = t.TempDir()
			checks := []string{"video"}
			if _, err := org.SaveSkill(e.ctx, e.db, e.g.Data, org.SkillInput{Name: "video", Checks: &checks,
				Files: map[string][]byte{"SKILL.md": []byte("做视频")}}, "u1"); err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			if err := os.Mkdir(filepath.Join(dir, "out"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "out", "demo.mp4"), []byte("fake video"), 0o600); err != nil {
				t.Fatal(err)
			}
			head, tail := root, detail
			if !atStart {
				head, tail = tail, root
			}
			stderr := head + "\n" + strings.Repeat("stack frame\n", 100) + "MIDDLE-MUST-DISAPPEAR\n" + strings.Repeat("stack frame\n", 100) + tail + "\n"
			file := filepath.Join(dir, "stderr.txt")
			if err := os.WriteFile(file, []byte(stderr), 0o600); err != nil {
				t.Fatal(err)
			}
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			x := gates.NewExec()
			x.Env["ATRIUM_TEST_STDERR_FILE"] = file
			e.g.R = stderrCommand{t: t, x: x, executable: executable, stderr: stderr}
			task, err := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "检查失败诊断", Dir: dir, Skill: "video"}, "u1")
			if err != nil {
				t.Fatal(err)
			}
			e.start(task.ID, "claude+opus")
			if err := ledger.Record(e.ctx, e.db, task.ID, gates.KindWorktree, "dispatch", `{"host":"h1","dir":"`+filepath.ToSlash(dir)+`"}`); err != nil {
				t.Fatal(err)
			}
			e.exit(task.ID)
			e.sweep()
			if got := e.state(task.ID); got != "queued/" {
				t.Fatalf("非零退出应交回而不是误判跑不起来：%s", got)
			}
			for _, kind := range []string{gates.KindSkillCheck, string(ledger.Bounce)} {
				body, found, err := gates.Last(e.ctx, e.db, task.ID, kind)
				if err != nil || !found {
					t.Fatalf("缺少 %s 经历：%v", kind, err)
				}
				if kind == string(ledger.Bounce) {
					var event struct{ Note string }
					if err := json.Unmarshal([]byte(body), &event); err != nil {
						t.Fatal(err)
					}
					body = event.Note
				}
				for _, want := range []string{root, detail, "\n…\n", "exit status 7"} {
					if !strings.Contains(body, want) {
						t.Fatalf("%s 经历丢了 %q：%s", kind, want, body)
					}
				}
				if strings.Contains(body, "MIDDLE-MUST-DISAPPEAR") || strings.Contains(body, "stdout-kept-separate") {
					t.Fatalf("%s 不应混入中间栈或 stdout：%s", kind, body)
				}
				t.Logf("%s 经历：\n%s", kind, body)
			}
		})
	}
}
