package merge_test

import (
	"context"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"strings"
	"testing"
)

type holdDuringCI struct {
	gates.Runner
	hold  func()
	fired bool
}

func (r *holdDuringCI) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	if !r.fired && name == "gh" && len(args) > 1 && args[0] == "pr" && args[1] == "checks" {
		r.fired = true
		r.hold()
	}
	return r.Runner.Run(ctx, dir, name, args...)
}

func TestTaskAcceptanceActualMerge(t *testing.T) {
	for _, mode := range []string{"hold_in_queue", "hold_during_ci", "head_change", "rebase", "redelivery_rebase", "conflict"} {
		t.Run(mode, func(t *testing.T) {
			e := setup(t, nil)
			files := map[string]string{"a.go": "package a\n"}
			if mode == "conflict" {
				files = map[string]string{"README.md": "mine\n"}
			}
			task := e.deliver("task-t1", files)
			hold := func() {
				t.Helper()
				if _, err := ledger.Decide(e.ctx, e.db, task.ID, "hold", "zcode未完成，不合入", "u1"); err != nil {
					t.Fatal(err)
				}
			}
			g := &gates.Gate{DB: e.db, R: e.gh, Pause: e.q.Pause, Log: e.q.Log}
			if mode != "hold_during_ci" {
				hold()
				e.drain()
				if e.get(task.ID).Stage != ledger.StageAccept {
					t.Fatal("队列暂缓没有转验收")
				}
			}
			if mode == "head_change" || mode == "rebase" || mode == "redelivery_rebase" || mode == "conflict" {
				if _, err := g.Accept(e.ctx, task.ID, "u1"); err != nil {
					t.Fatal(err)
				}
				if mode == "redelivery_rebase" {
					for _, ev := range []ledger.Event{{Kind: ledger.Bounce}, {Kind: ledger.Start}, {Kind: ledger.ExitOK}, {Kind: ledger.GatePass, Land: ledger.StageMerge}} {
						if _, err := ledger.Apply(e.ctx, e.db, task.ID, ev, "runtime", "阶段修复重派"); err != nil {
							t.Fatal(err)
						}
					}
					if err := ledger.Record(e.ctx, e.db, task.ID, "result", "runtime", "目标未完成，阶段不合入\n交付结论：完成"); err != nil {
						t.Fatal(err)
					}
					e.drain()
					if got := e.get(task.ID); got.Stage != ledger.StageAccept || e.gh.PRs[0].State != "OPEN" {
						t.Fatalf("重派完成末行绕过决定：%+v", got)
					}
					if _, err := g.Accept(e.ctx, task.ID, "u1"); err != nil {
						t.Fatal(err)
					}
				}
				if mode == "head_change" {
					e.gh.Must(e.gh.Work, "fetch", "origin")
					e.gh.Must(e.gh.Work, "checkout", "-B", "task-t1", "origin/task-t1")
					e.gh.Write(e.gh.Work, "changed.go", "package changed\n")
					e.gh.Must(e.gh.Work, "add", "-A")
					e.gh.Must(e.gh.Work, "commit", "-m", "new delivery")
					e.gh.Must(e.gh.Work, "push", "origin", "task-t1")
				} else if mode == "conflict" {
					e.gh.Commit(map[string]string{"README.md": "theirs\n"})
				} else {
					e.gh.Commit(map[string]string{"other.go": "package other\n"})
				}
			}
			if mode == "hold_during_ci" {
				e.q.R = &holdDuringCI{Runner: e.gh, hold: hold}
			}
			e.drain()
			got := e.get(task.ID)
			if e.gh.PRs[0].State != "OPEN" {
				t.Fatal("未重新验收就已实际合入")
			}
			for _, call := range e.gh.Calls {
				if strings.HasPrefix(call, "pr merge ") {
					t.Fatalf("暂缓未拦实际命令：%s", call)
				}
			}
			if mode == "conflict" {
				if got.Status != ledger.Queued {
					t.Fatalf("冲突应交回：%+v", got)
				}
				if a, _ := ledger.AcceptanceOf(e.ctx, e.db, task.ID); a == nil {
					t.Fatal("冲突丢决定")
				}
				t.Log("冲突交回保留决定和过期授权，PR 未合入")
				return
			}
			if got.Stage != ledger.StageAccept {
				t.Fatalf("应等待重新验收：%+v", got)
			}
			if _, err := g.Accept(e.ctx, task.ID, "a99"); err == nil {
				t.Fatal("下级越权")
			}
			if _, err := g.Accept(e.ctx, task.ID, "u1"); err != nil {
				t.Fatal(err)
			}
			e.drain()
			if got := e.get(task.ID); got.Status != ledger.Done || e.gh.PRs[0].State != "MERGED" {
				t.Fatalf("明确验收后实际合入：%+v %s", got, e.lastNote(task.ID))
			}
			t.Logf("%s：暂缓/交付变化阻止实际 gh pr merge；重新验收后真实本地 git 合入成功", mode)
		})
	}
}
