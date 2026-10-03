package gates_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
)

// dept 建一个设了验收人的部门，返回短号。
func (e *env) dept(accept string) string {
	e.t.Helper()
	d, err := org.Add(e.ctx, e.db, org.NewDept{Name: "验收演练"})
	if err != nil {
		e.t.Fatal(err)
	}
	if _, err := org.Edit(e.ctx, e.db, d.ID, org.DeptPatch{Accept: &accept}); err != nil {
		e.t.Fatal(err)
	}
	return d.ID
}

// inDept 造一件挂在部门 dept 下、执行者刚交付停在交付检查的任务；repo 为空是没有仓库的活。
func (e *env) inDept(dept, repo, worker, dir string) ledger.Task {
	e.t.Helper()
	t, err := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "做事", Org: dept, Repo: repo}, "u1")
	if err != nil {
		e.t.Fatal(err)
	}
	e.start(t.ID, worker)
	if err := ledger.Record(e.ctx, e.db, t.ID, gates.KindWorktree, "dispatch", `{"host":"h1","dir":"`+filepath.ToSlash(dir)+`"}`); err != nil {
		e.t.Fatal(err)
	}
	return e.exit(t.ID)
}

func (e *env) state(id string) string {
	t := e.get(id)
	return string(t.Status) + "/" + string(t.Stage)
}

func code(err error) string {
	if ae, ok := err.(*api.Error); ok {
		return ae.Code
	}
	return ""
}

// 验收人是用户：交付检查通过后停在等验收并投秘书；负责人不能代验；打回交回原执行者，第 3 次转受阻；验收通过进合入队列。
func TestUserAcceptsPR(t *testing.T) {
	e := setup(t)
	o := e.dept(org.AcceptUser)
	dir := filepath.Join(t.TempDir(), "wt")
	e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
	e.gh.Open("t1-work", goodBody)
	task := e.inDept(o, "o/r", "claude+opus", dir)
	e.sweep()
	if got := e.state(task.ID); got != "running/accept" || !strings.Contains(e.lastNote(task.ID), "等你验收") {
		t.Fatalf("应停在等验收：%s %s", got, e.lastNote(task.ID))
	}
	var target, level, body string
	if err := e.db.QueryRowContext(e.ctx, `SELECT target, level, body FROM events WHERE task = ? ORDER BY id DESC LIMIT 1`, task.ID).
		Scan(&target, &level, &body); err != nil || target != "secretary" || level != "act" || !strings.Contains(body, `"accept_by":"user"`) {
		t.Fatalf("等验收应要处理地投秘书：%s %s %s %v", target, level, body, err)
	}
	e.sweep() // 等验收不归交付检查循环推进
	if got := e.state(task.ID); got != "running/accept" {
		t.Fatalf("交付检查循环动了等验收的任务：%s", got)
	}
	if _, err := e.g.Accept(e.ctx, task.ID, "a1"); code(err) != "forbidden" {
		t.Fatalf("负责人不能代用户验收：%v", err)
	}
	if _, err := e.g.Reject(e.ctx, task.ID, "u1", " "); code(err) != "usage" {
		t.Fatalf("打回要写原因：%v", err)
	}
	for i := 1; i <= 3; i++ {
		got, err := e.g.Reject(e.ctx, task.ID, "u1", "本地跑不起来")
		if err != nil {
			t.Fatal(err)
		}
		if i < 3 {
			if got.Status != ledger.Queued || e.queued(task.ID) {
				t.Fatalf("第 %d 次打回应交回原执行者（不写队列行）：%+v", i, got)
			}
			e.db.ExecContext(e.ctx, `DELETE FROM queue WHERE task = ?`, task.ID)
			ledger.Apply(e.ctx, e.db, task.ID, ledger.Event{Kind: ledger.Start}, "dispatch", "")
			e.exit(task.ID)
			e.sweep()
			if got := e.state(task.ID); got != "running/accept" {
				t.Fatalf("重交后应再等验收：%s", got)
			}
		} else if got.Status != ledger.Blocked || got.Stage != ledger.StageAccept {
			t.Fatalf("第 3 次打回应转受阻：%+v", got)
		}
	}
	if _, err := e.g.Accept(e.ctx, task.ID, "u1"); code(err) != "conflict" {
		t.Fatalf("受阻的不能验收：%v", err)
	}
	// 放行后重新交付，这次验收通过：进合入队列。
	ledger.Apply(e.ctx, e.db, task.ID, ledger.Event{Kind: ledger.Enqueue}, "u1", "")
	e.db.ExecContext(e.ctx, `DELETE FROM queue WHERE task = ?`, task.ID)
	ledger.Apply(e.ctx, e.db, task.ID, ledger.Event{Kind: ledger.Start}, "dispatch", "")
	e.exit(task.ID)
	e.sweep()
	got, err := e.g.Accept(e.ctx, task.ID, "secretary")
	if err != nil || got.Status != ledger.Running || got.Stage != ledger.StageMerge {
		t.Fatalf("验收通过应进合入队列：%+v %v", got, err)
	}
}

// 验收人是负责人：负责人能判；审阅任务是运行时建的，不等人验收。
func TestLeaderAcceptsAfterReview(t *testing.T) {
	e := setup(t)
	o := e.dept(org.AcceptLeader)
	dir := filepath.Join(t.TempDir(), "wt")
	e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
	e.gh.Open("t1-work", goodBody)
	task := e.inDept(o, "o/r", "claude+haiku", dir) // 低信任：先审阅
	e.sweep()
	ref, _, _ := gates.Last(e.ctx, e.db, task.ID, gates.KindReviewer)
	if rt := e.get(ref); rt.Org != o {
		t.Fatalf("审阅任务应在同一部门：%+v", rt)
	}
	e.db.ExecContext(e.ctx, `DELETE FROM queue WHERE task = ?`, ref)
	ledger.Apply(e.ctx, e.db, ref, ledger.Event{Kind: ledger.Start}, "dispatch", "")
	w := "codex+gpt"
	ledger.SetFacts(e.ctx, e.db, ref, ledger.Facts{Worker: &w}, "dispatch")
	ledger.Record(e.ctx, e.db, ref, gates.KindResult, "dispatch", "审阅结论：通过")
	ledger.Record(e.ctx, e.db, ref, gates.KindWorktree, "dispatch", `{"host":"h1","dir":"`+filepath.ToSlash(t.TempDir())+`"}`)
	e.exit(ref)
	e.sweep()
	if got := e.state(ref); got != "done/gate" {
		t.Fatalf("审阅任务不等验收，应直接完成：%s", got)
	}
	if got := e.state(task.ID); got != "running/accept" {
		t.Fatalf("审阅过了应等负责人验收：%s %s", got, e.lastNote(task.ID))
	}
	if got, err := e.g.Accept(e.ctx, task.ID, "a1"); err != nil || got.Stage != ledger.StageMerge {
		t.Fatalf("负责人验收通过应进合入队列：%+v %v", got, err)
	}
}

// 没有仓库的活：message 没有应用，验收人是用户也过了交付检查就完成；choice 验收通过才登记选项单；choice.json 不合法交付检查就交回。
func TestAcceptNoRepo(t *testing.T) {
	e := setup(t)
	o := e.dept(org.AcceptUser)
	e.choiceMaterial(o)
	msg := e.inDept(o, "", "claude+opus", t.TempDir())
	e.sweep()
	if got := e.state(msg.ID); got != "done/gate" {
		t.Fatalf("message 没有应用，不等验收，应直接完成：%s %s", got, e.lastNote(msg.ID))
	}

	choiceDir := t.TempDir()
	opt := `{"title":"T","gain":"g","why_now":"w","cost":"c","if_not":"i","evidence":"m1/27.svg"}`
	os.WriteFile(filepath.Join(choiceDir, agenda.ChoiceFile), []byte(`{"title":"下一步","options":[`+opt+`,`+opt+`,`+opt+`],"recommend":[1],"reason":"快"}`), 0o600)
	research := e.inDept(o, "", "claude+opus", choiceDir)
	e.sweep()
	if got := e.state(research.ID); got != "running/accept" {
		t.Fatalf("choice 应等验收：%s %s", got, e.lastNote(research.ID))
	}
	if open, _ := agenda.Choices(e.ctx, e.db, "", false); len(open) != 0 {
		t.Fatalf("验收前不该登记选项单：%+v", open)
	}
	if got, err := e.g.Accept(e.ctx, research.ID, "u1"); err != nil || got.Status != ledger.Done || !strings.Contains(e.lastNote(research.ID), "登记了选项单") {
		t.Fatalf("choice 验收通过应登记选项单并完成：%+v %v %s", got, err, e.lastNote(research.ID))
	}

	badDir := t.TempDir()
	os.WriteFile(filepath.Join(badDir, agenda.ChoiceFile), []byte(`{"title":""}`), 0o600)
	bad := e.inDept(o, "", "claude+opus", badDir)
	e.sweep()
	if got := e.state(bad.ID); got != "queued/" {
		t.Fatalf("choice.json 不合法应在交付检查交回：%s %s", got, e.lastNote(bad.ID))
	}
}

// 有工作地点的活（dir）：交付检查看执行者的交付结论，东西已在原地、没有应用，验收人是用户也不等验收，直接完成；
// 文件夹里的 choice.json 是用户自己的文件，不当选项单登记。
func TestAcceptDir(t *testing.T) {
	e := setup(t)
	place := t.TempDir()
	os.WriteFile(filepath.Join(place, agenda.ChoiceFile), []byte(`{"title":""}`), 0o600)
	task, err := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "写文章", Org: e.dept(org.AcceptUser), Dir: place}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	e.start(task.ID, "claude+opus")
	ledger.Record(e.ctx, e.db, task.ID, gates.KindWorktree, "dispatch", `{"host":"h1","dir":"`+filepath.ToSlash(place)+`"}`)
	e.exit(task.ID)
	e.sweep()
	if got := e.state(task.ID); got != "done/gate" || !strings.Contains(e.lastNote(task.ID), "工作地点") {
		t.Fatalf("dir 没有应用，不等验收，应过了交付检查直接完成：%s %s", got, e.lastNote(task.ID))
	}
	if open, _ := agenda.Choices(e.ctx, e.db, "", false); len(open) != 0 {
		t.Fatalf("dir 不该登记选项单：%+v", open)
	}
}

// 提示词里怎么交由交付方式定：GitHub 仓库更新或新开 PR，本机仓库只提交不推送，没有仓库不提 PR。
// 审阅任务不附交付结论那条：它的最后一行是审阅结论，两条都写会让审阅结论不在末行（t877 第 3 轮）。
func TestPromptRules(t *testing.T) {
	pr := strings.Join(gates.PromptRules("o/r", "", "", "task-t1", false), "\n")
	if !strings.Contains(pr, "当前任务工作树的分支 task-t1 上提交、推送") ||
		!strings.Contains(pr, "已有 PR 就更新它") || !strings.Contains(pr, "不要进入其他任务的工作树") {
		t.Fatalf("pr：%s", pr)
	}
	local := strings.Join(gates.PromptRules(filepath.Join(t.TempDir(), "site"), "", "", "task-t1", false), "\n")
	if !strings.Contains(local, "在分支 task-t1 上提交；不要推送") || strings.Contains(local, "PR") {
		t.Fatalf("local 不该要求推送、开 PR：%s", local)
	}
	msg := strings.Join(gates.PromptRules("", "", "", "", false), "\n")
	if strings.Contains(msg, "PR") || !strings.Contains(msg, "没有仓库") || !strings.Contains(msg, "交付结论") {
		t.Fatalf("message 不该要求开 PR、要附交付结论：%s", msg)
	}
	dir := strings.Join(gates.PromptRules("", filepath.Join(t.TempDir(), "blog"), "", "", false), "\n")
	if strings.Contains(dir, "PR") || !strings.Contains(dir, "原地干") {
		t.Fatalf("dir 应在原地干、不开 PR：%s", dir)
	}
	review := strings.Join(gates.PromptRules("", "", "", "", true), "\n")
	if strings.Contains(review, "交付结论") {
		t.Fatalf("审阅任务不该附交付结论：%s", review)
	}
}
