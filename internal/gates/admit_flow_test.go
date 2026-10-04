package gates_test

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// finishRound 记这一轮拉起和回复，再正常退出进入交付检查。上一轮的回复不带进这一轮。
func (e *env) finishRound(id, reply string) {
	e.t.Helper()
	if e.get(id).Status == ledger.Queued {
		e.db.ExecContext(e.ctx, `DELETE FROM queue WHERE task = ?`, id)
		if _, err := ledger.Apply(e.ctx, e.db, id, ledger.Event{Kind: ledger.Start}, "dispatch", ""); err != nil {
			e.t.Fatal(err)
		}
	}
	if err := ledger.Record(e.ctx, e.db, id, workers.RunKind, "dispatch", "{}"); err != nil {
		e.t.Fatal(err)
	}
	if err := ledger.Record(e.ctx, e.db, id, gates.KindResult, "dispatch", reply); err != nil {
		e.t.Fatal(err)
	}
	if _, err := ledger.Apply(e.ctx, e.db, id, ledger.Event{Kind: ledger.ExitOK}, "dispatch", ""); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) preparePR(draft bool) (ledger.Task, string) {
	e.t.Helper()
	dir := filepath.Join(e.t.TempDir(), "wt")
	e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
	e.gh.Open("t1-work", goodBody)
	e.gh.PRs[0].Draft = draft
	task, err := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "做事", Repo: "o/r"}, "u1")
	if err != nil {
		e.t.Fatal(err)
	}
	e.start(task.ID, "claude+opus")
	if err := ledger.Record(e.ctx, e.db, task.ID, gates.KindWorktree, "dispatch", `{"host":"h1","dir":"`+filepath.ToSlash(dir)+`"}`); err != nil {
		e.t.Fatal(err)
	}
	return task, dir
}

func TestGateRefusesDraftAndNotDone(t *testing.T) {
	cases := []struct {
		name, reply string
		draft       bool
		want        []string
		blocked     bool
	}{
		{"草稿 PR", "做完了\n交付结论：完成", true, []string{"PR #1 还是草稿", "gh pr ready 1 -R o/r", "或修完再交"}, false},
		{"没做成", "还差测试\n交付结论：没做成", false, []string{"交付结论：没做成（还差测试）", "修完再交", "交付结论：完成"}, false},
		{"未完成", "差一步\n交付结论：未完成", false, []string{"交付结论：未完成（差一步）", "修完再交"}, false},
		{"受阻停车不交回", "等设计稿\n交付结论：受阻", false, []string{"交付结论：受阻（等设计稿）", "停下等外部依赖"}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := setup(t)
			task, _ := e.preparePR(c.draft)
			e.finishRound(task.ID, c.reply)
			e.sweep()
			got := e.get(task.ID)
			note := e.lastNote(task.ID)
			t.Logf("拦住：%s", note)
			if c.blocked {
				if got.Status != ledger.Blocked || e.queued(task.ID) || e.count(task.ID, string(ledger.Bounce)) != 0 {
					t.Fatalf("受阻应停下不交回：%+v queued=%v bounce=%d", got, e.queued(task.ID), e.count(task.ID, string(ledger.Bounce)))
				}
			} else if got.Status != ledger.Queued || got.Stage != ledger.StageNone || e.queued(task.ID) {
				t.Fatalf("应交回且不进合入队列：%+v", got)
			}
			for _, w := range c.want {
				if !strings.Contains(note, w) {
					t.Errorf("原因缺 %q：%s", w, note)
				}
			}
		})
	}
}

// t975 实况：等外部依赖（#806 合入）、PR 保持草稿，执行者写「受阻」。
// 关卡直接停车转 blocked、记 block 通知负责人，不交回、不重拉执行者；负责人解除后 task run 继续（现机制）。
func TestGateBlocksOnBlockedConclusion(t *testing.T) {
	e := setup(t)
	task, _ := e.preparePR(true) // PR 是草稿
	e.finishRound(task.ID, "等 #806 合入后再转 ready\n交付结论：受阻")
	e.sweep()
	got := e.get(task.ID)
	note := e.lastNote(task.ID)
	t.Logf("受阻停车：%s/%s %s", got.Status, got.Stage, note)
	if got.Status != ledger.Blocked || got.Stage != ledger.StageGate {
		t.Fatalf("受阻应停下转 blocked：%+v", got)
	}
	if e.queued(task.ID) || e.count(task.ID, string(ledger.Bounce)) != 0 {
		t.Fatalf("受阻不该交回重拉：queued=%v bounce=%d", e.queued(task.ID), e.count(task.ID, string(ledger.Bounce)))
	}
	if n := e.count(task.ID, "block"); n != 1 {
		t.Fatalf("该记一次 block：%d", n)
	}
	for _, w := range []string{"交付结论：受阻（等 #806 合入后再转 ready）", "停下等外部依赖", "不算失败"} {
		if !strings.Contains(note, w) {
			t.Errorf("备注缺 %q：%s", w, note)
		}
	}
	e.sweep() // 已受阻的交付检查阶段不再被扫，不重复转状态
	if n := e.count(task.ID, "block"); n != 1 {
		t.Fatalf("重扫不该重复转 blocked：block %d 次", n)
	}
	if _, err := ledger.Apply(e.ctx, e.db, task.ID, ledger.Event{Kind: ledger.Enqueue}, "u1", ""); err != nil {
		t.Fatalf("受阻后重派：%v", err)
	}
	if got := e.get(task.ID); got.Status != ledger.Queued || got.Stage != ledger.StageNone {
		t.Fatalf("重派应回队列：%+v", got)
	}
}

// 转 ready 只消掉草稿这一条。这一轮仍写没做成就还是不通过；上一轮的完成也不替这一轮担保。
func TestReadyDoesNotSkipRecheck(t *testing.T) {
	e := setup(t)
	task, _ := e.preparePR(true)
	e.finishRound(task.ID, "先交一版\n交付结论：完成")
	e.sweep()
	note := e.lastNote(task.ID)
	t.Logf("第 1 轮草稿：%s", note)
	if e.get(task.ID).Status != ledger.Queued || !strings.Contains(note, "gh pr ready 1 -R o/r") {
		t.Fatalf("草稿应拦住：%s %+v", note, e.get(task.ID))
	}

	e.gh.PRs[0].Draft = false // 执行者自己 gh pr ready
	e.finishRound(task.ID, "转好了但没做完\n交付结论：没做成")
	e.sweep()
	note = e.lastNote(task.ID)
	t.Logf("第 2 轮已 ready 仍没做成：%s", note)
	if got := e.get(task.ID); got.Status != ledger.Queued || got.Stage == ledger.StageMerge || e.queued(task.ID) {
		t.Fatalf("转 ready 不能跳过重查：%+v", got)
	}
	if !strings.Contains(note, "交付结论：没做成（转好了但没做完）") || !strings.Contains(note, "修完再交") {
		t.Fatalf("应要求修完再交：%s", note)
	}

	e.finishRound(task.ID, "补完了\n交付结论：完成")
	e.sweep()
	got := e.get(task.ID)
	t.Logf("第 3 轮完成：%s %s", got.Stage, e.lastNote(task.ID))
	if got.Status != ledger.Running || got.Stage != ledger.StageMerge {
		t.Fatalf("这一轮完成且不是草稿，应进合入队列：%+v %s", got, e.lastNote(task.ID))
	}
}

// 交付检查曾经通过不算数：等验收期间 PR 变回草稿，或这一轮回复改成没做成，进队列前都要再拦住。
func TestMergeEntryRechecks(t *testing.T) {
	t.Run("等验收期间变回草稿", func(t *testing.T) {
		e := setup(t)
		o := e.dept(org.AcceptUser)
		dir := filepath.Join(t.TempDir(), "wt")
		e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
		e.gh.Open("t1-work", goodBody)
		task := e.inDept(o, "o/r", "claude+opus", dir)
		e.sweep()
		if e.state(task.ID) != "running/accept" {
			t.Fatalf("应先停在等验收：%s %s", e.state(task.ID), e.lastNote(task.ID))
		}
		body, found, err := gates.Last(e.ctx, e.db, task.ID, gates.KindGate)
		if err != nil || !found || !strings.Contains(body, `"pass":true`) {
			t.Fatalf("前置：交付检查记录曾通过：%s %v", body, err)
		}
		e.gh.PRs[0].Draft = true
		got, err := e.g.Accept(e.ctx, task.ID, "u1")
		note := e.lastNote(task.ID)
		t.Logf("验收时重查草稿：%s", note)
		if err != nil || got.Status != ledger.Queued || got.Stage == ledger.StageMerge {
			t.Fatalf("应交回而不是进队列：%+v %v", got, err)
		}
		if !strings.Contains(note, "gh pr ready 1 -R o/r") || !strings.Contains(note, "或修完再交") {
			t.Fatalf("原因应可执行：%s", note)
		}
		again, _, _ := gates.Last(e.ctx, e.db, task.ID, gates.KindGate)
		if again != body {
			t.Fatal("重查不应改写旧的交付检查记录")
		}
	})

	t.Run("验收前这一轮回复改成没做成", func(t *testing.T) {
		e := setup(t)
		o := e.dept(org.AcceptUser)
		dir := filepath.Join(t.TempDir(), "wt")
		e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
		e.gh.Open("t1-work", goodBody)
		task := e.inDept(o, "o/r", "claude+opus", dir)
		e.sweep()
		if err := ledger.Record(e.ctx, e.db, task.ID, gates.KindResult, "dispatch", "发现没做完\n交付结论：没做成"); err != nil {
			t.Fatal(err)
		}
		got, err := e.g.Accept(e.ctx, task.ID, "u1")
		note := e.lastNote(task.ID)
		t.Logf("验收时重查结论：%s", note)
		if err != nil || got.Status != ledger.Queued || strings.Contains(e.state(task.ID), "merge") {
			t.Fatalf("没做成不能进队列：%+v %v %s", got, err, note)
		}
		if !strings.Contains(note, "交付结论：没做成（发现没做完）") || !strings.Contains(note, "修完再交") {
			t.Fatalf("原因应可执行：%s", note)
		}
	})
}
