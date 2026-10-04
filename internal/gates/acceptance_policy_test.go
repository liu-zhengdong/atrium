package gates_test

import (
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"path/filepath"
	"testing"
)

func TestTaskAcceptanceDelivery(t *testing.T) {
	for _, mode := range []string{"pr", "message", "zero_diff"} {
		t.Run(mode, func(t *testing.T) {
			e := setup(t)
			dir, repo := "", ""
			if mode != "message" {
				dir = filepath.Join(t.TempDir(), "wt")
				repo = "o/r"
				e.gh.Branch(dir, "task-t1", map[string]string{"a.go": "package a\n"})
				e.gh.Open("task-t1", goodBody+"\nzcode 尚未完成，此阶段不合入")
				if mode == "zero_diff" {
					e.gh.Must(dir, "reset", "--hard", "origin/main")
					e.gh.Must(dir, "push", "--force", "origin", "HEAD:task-t1")
				}
			}
			var task ledger.Task
			if mode == "message" {
				var err error
				task, err = ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "阶段说明"}, "u1")
				if err != nil {
					t.Fatal(err)
				}
				e.start(task.ID, "claude+opus")
				task = e.exit(task.ID)
			} else {
				task = e.inDept("", repo, "claude+opus", dir)
			}
			if _, err := ledger.Decide(e.ctx, e.db, task.ID, "hold", "目标未完成，阶段待验收", "u1"); err != nil {
				t.Fatal(err)
			}
			e.sweep()
			if got := e.get(task.ID); got.Stage != ledger.StageAccept || got.Status != ledger.Running {
				t.Fatalf("%s 未停在验收：%+v %s", mode, got, e.lastNote(task.ID))
			}
			if _, err := e.g.Accept(e.ctx, task.ID, "a99"); err == nil {
				t.Fatal("下级绕过验收")
			}
			if mode == "zero_diff" {
				if _, err := ledger.Decide(e.ctx, e.db, task.ID, "resume", "明确解除", "u1"); err != nil {
					t.Fatal(err)
				}
			}
			got, err := e.g.Accept(e.ctx, task.ID, "u1")
			if err != nil {
				t.Fatal(err)
			}
			if mode == "pr" {
				if got.Stage != ledger.StageMerge {
					t.Fatalf("验收后应进队列：%+v", got)
				}
				pr, err := gates.ViewPR(e.ctx, e.gh, "o/r", got.PR)
				if err != nil {
					t.Fatal(err)
				}
				if err := ledger.CheckApplication(e.ctx, e.db, task.ID, pr.HeadID); err != nil {
					t.Fatal(err)
				}
			} else if got.Status != ledger.Done {
				t.Fatalf("明确验收后完成：%+v", got)
			}
			t.Logf("%s：完成末行不能撤销暂缓；越权验收拒绝；原决策人验收正常推进", mode)
		})
	}
}
