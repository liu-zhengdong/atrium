package dispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 测试二进制充当执行者：只在当前目录追加、提交、推送，不访问真实模型。
func continuePRWorker() int {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	old, _ := os.ReadFile("result.txt")
	if err := os.WriteFile("result.txt", append(old, []byte("续做\n")...), 0600); err != nil {
		return 1
	}
	for _, args := range [][]string{{"add", "result.txt"}, {"-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "续做"}, {"push", "--quiet", "origin", "HEAD"}} {
		if _, err := run(ctx, "", "git", args...); err != nil {
			fmt.Println(err)
			return 1
		}
	}
	fmt.Println("DONE\n交付结论：完成")
	return 0
}

func TestContinuePRFromAcceptance(t *testing.T) {
	d, gh, ctx := reclaimRig(t)
	dept, err := org.Add(ctx, d.env.DB, org.NewDept{Name: "续做"})
	if err != nil {
		t.Fatal(err)
	}
	accept := org.AcceptUser
	if _, err := org.Edit(ctx, d.env.DB, dept.ID, org.DeptPatch{Accept: &accept}); err != nil {
		t.Fatal(err)
	}
	task, err := ledger.Add(ctx, d.env.DB, ledger.NewTask{Title: "原 PR", Repo: gh.Work, Org: dept.ID}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Dir(exe)+string(os.PathListSeparator)+os.Getenv("PATH"))
	quoted, _ := json.Marshal(filepath.Base(exe))
	source := "---\nprotocol: cli\ncommand: " + string(quoted) + "\nargs: [\"--continue-pr-worker\", \"{prompt}\"]\ndone_match: '^DONE$'\ntrust: high\nchecks: [finished, pr_exists]\n---\n"
	if _, err := workers.SaveProfile(ctx, d.env.DB, "harness/continuefake", workers.Edit{Source: &source}, "u1"); err != nil {
		t.Fatal(err)
	}
	oldPick := pickHost
	pickHost = func(context.Context, *app.Env, HostNeed, string) (HostChoice, error) {
		return HostChoice{Kind: "run", Host: LocalHost}, nil
	}
	t.Cleanup(func() { pickHost = oldPick })
	gate := gates.Gate{DB: d.env.DB, Data: d.env.Paths.Data, Pause: d.env.Pause, R: gh, Log: d.env.Log}
	var originalHead, originalPR, originalDir string
	for round := 1; round <= 2; round++ {
		if round == 2 {
			applyReclaim(t, d, ctx, task.ID, ledger.Event{Kind: ledger.Set, To: ledger.Todo})
			if _, err := gate.Accept(ctx, task.ID, "u1"); err == nil {
				t.Fatal("重开后旧验收仍然有效")
			}
			if _, err := ledger.Edit(ctx, d.env.DB, task.ID, ledger.Patch{Repo: &gh.Work}, "u1"); err != nil {
				t.Fatal(err)
			}
			if _, err := Tell(ctx, d.env, task.ID, "续做现有 PR，追加一行", "u1"); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := Enqueue(ctx, d.env, task.ID, Options{Worker: "continuefake"}, "u1"); err != nil {
			t.Fatal(err)
		}
		stop := runReclaimLoop(t, d, ctx)
		waitReclaim(t, ctx, func() bool {
			tk, err := ledger.Get(ctx, d.env.DB, task.ID)
			return err == nil && tk.Stage == ledger.StageGate
		})
		stop()
		w, found, err := gates.Workspace(ctx, d.env.DB, task.ID)
		if err != nil || !found {
			t.Fatalf("工作树：%+v %v", w, err)
		}
		if round == 1 {
			originalDir = w.Dir
			gh.Open(Branch(task.ID), "## 端到端验证\n隔离执行者提交推送。")
		} else if w.Dir != originalDir {
			t.Fatal("续做换了工作树")
		}
		// 假 gh 使用 o/r；Git 的远端始终是临时 bare 仓库。
		if _, err := ledger.Edit(ctx, d.env.DB, task.ID, ledger.Patch{Repo: &gh.Repo}, "u1"); err != nil {
			t.Fatal(err)
		}
		if err := gate.Sweep(ctx); err != nil {
			t.Fatal(err)
		}
		tk, err := ledger.Get(ctx, d.env.DB, task.ID)
		if err != nil || tk.Status != ledger.Running || tk.Stage != ledger.StageAccept {
			t.Fatalf("第 %d 轮未重新过关卡等验收：%+v %v", round, tk, err)
		}
		body, found, err := gates.Last(ctx, d.env.DB, task.ID, gates.KindGate)
		var record struct {
			Facts gates.Facts `json:"facts"`
		}
		if err != nil || !found || json.Unmarshal([]byte(body), &record) != nil {
			t.Fatalf("关卡事实：%s %v", body, err)
		}
		facts := record.Facts
		if !facts.Changed() || !facts.Pushed || facts.Ahead != round || facts.PR == nil || facts.PR.Number != 1 || facts.PR.HeadID != facts.Head || facts.Branch != Branch(task.ID) {
			t.Fatalf("第 %d 轮事实：%+v", round, facts)
		}
		if round == 1 {
			originalHead, originalPR = facts.Head, tk.PR
		} else {
			if facts.Head == originalHead || tk.PR != originalPR || len(gh.PRs) != 1 {
				t.Fatal("续做没有新提交或换了 PR")
			}
			prompt, err := os.ReadFile(filepath.Join(TaskDir(d.env.Paths.Data, task.ID), "prompt-2.md"))
			if err != nil || !strings.Contains(string(prompt), originalPR) || !strings.Contains(string(prompt), "追加一行") {
				t.Fatalf("续做提示词未带原 PR 与补充：%v", err)
			}
		}
		t.Logf("第 %d 轮：ahead=%d，pushed=%t，PR=%s，重新等验收", round, facts.Ahead, facts.Pushed, tk.PR)
	}
}

func TestWorkdirOccupiedBranchStopsBeforeLaunch(t *testing.T) {
	d, gh, ctx := reclaimRig(t)
	task, err := ledger.Add(ctx, d.env.DB, ledger.NewTask{Title: "占用分支时不能拉起", Repo: gh.Work}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	branch := Branch(task.ID)
	other := filepath.Join(d.env.Paths.Data, "tasks", "t642", "repo")
	if err := os.MkdirAll(filepath.Dir(other), 0700); err != nil {
		t.Fatal(err)
	}
	gh.Must(gh.Work, "worktree", "add", "--quiet", "-b", branch, other, "main")
	before := gh.Must(other, "rev-parse", "HEAD")
	_, _, err = Workdir(ctx, d.env.Paths.Data, task.ID, gh.Work, "")
	if err == nil || !strings.Contains(err.Error(), "t642") || !strings.Contains(err.Error(), branch) || !strings.Contains(err.Error(), "拉起前停止") {
		t.Fatalf("占用错误不清楚：%v", err)
	}
	if err := d.launch(ctx, task, launchOpts{Host: LocalHost}); err == nil || !strings.Contains(err.Error(), "t642") {
		t.Fatalf("拉起入口未停止：%v", err)
	}
	if launched, err := workers.LastRun(ctx, d.env.DB, task.ID); err != nil || launched != nil {
		t.Fatalf("占用时仍登记了执行者：%+v %v", launched, err)
	}
	if after := gh.Must(other, "rev-parse", "HEAD"); after != before {
		t.Fatal("改了占用者分支")
	}
	if _, err := os.Stat(filepath.Join(TaskDir(d.env.Paths.Data, task.ID), "repo")); !os.IsNotExist(err) {
		t.Fatal("占用时仍创建了工作树")
	}
	t.Log(err)
}
