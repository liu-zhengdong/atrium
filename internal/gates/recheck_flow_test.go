package gates_test

import (
	"bytes"
	"encoding/json"
	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/config"
	"net"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/merge"
	"github.com/liu-zhengdong/atrium/internal/org"
)

func (e *env) mergedRecheck(worker string) (ledger.Task, string) {
	dir := filepath.Join(e.t.TempDir(), "wt")
	e.gh.Branch(dir, "task-t1", map[string]string{"a.go": "package a\n"})
	e.gh.Open("task-t1", goodBody)
	head := e.gh.Must(dir, "rev-parse", "HEAD")
	if _, err := e.gh.Run(e.ctx, "", "gh", "pr", "merge", "1", "-R", "o/r", "--match-head-commit", head); err != nil {
		e.t.Fatal(err)
	}
	task := e.inDept(e.dept(org.AcceptLeader), "o/r", worker, dir)
	url := "https://github.com/o/r/pull/1"
	if err := ledger.SetFacts(e.ctx, e.db, task.ID, ledger.Facts{PR: &url}, "runtime"); err != nil {
		e.t.Fatal(err)
	}
	return e.get(task.ID), dir
}

func TestMergedRecheckLifecycle(t *testing.T) {
	for _, worker := range []string{"dsh+gpt", "dsh+k2"} {
		t.Run(worker, func(t *testing.T) {
			e := setup(t)
			task, _ := e.mergedRecheck(worker)
			if _, err := ledger.Decide(e.ctx, e.db, task.ID, "hold", "等待原负责人", "u1"); err != nil {
				t.Fatal(err)
			}
			e.sweep()
			if worker == "dsh+k2" {
				if e.state(task.ID) != "running/review" {
					t.Fatal(e.state(task.ID))
				}
				e.sweep()
				e.reviewExit(task.ID, "审阅结论：通过")
				e.sweep()
			}
			if e.state(task.ID) != "running/accept" {
				t.Fatal(e.state(task.ID), e.lastNote(task.ID))
			}
			if _, err := e.g.Accept(e.ctx, task.ID, "a99"); err == nil {
				t.Fatal("hold 被下级绕过")
			}
			got, err := e.g.Accept(e.ctx, task.ID, "u1")
			if err != nil || got.Status != ledger.Done || got.Stage == ledger.StageMerge {
				t.Fatalf("%+v %v", got, err)
			}
			t.Log("同一原任务：复核→原审阅/hold→负责人验收→完成，无重复合入")
		})
	}
}

func TestMergedRecheckRejects(t *testing.T) {
	for _, damage := range []string{"dirty", "unpushed", "head", "unfinished", "missing", "blocked", "unregistered", "no_merge"} {
		t.Run(damage, func(t *testing.T) {
			e := setup(t)
			task, dir := e.mergedRecheck("dsh+gpt")
			switch damage {
			case "dirty":
				e.gh.Write(dir, "dirty", "x")
			case "unpushed":
				e.gh.Must(dir, "push", "origin", "HEAD~1:refs/heads/task-t1", "--force")
			case "head":
				e.gh.Write(dir, "new", "x")
				e.gh.Must(dir, "add", "new")
				e.gh.Must(dir, "commit", "-m", "new")
			case "unfinished":
				ledger.Record(e.ctx, e.db, task.ID, gates.KindResult, "runtime", "交付结论：未完成")
			case "missing":
				ledger.Record(e.ctx, e.db, task.ID, gates.KindResult, "runtime", "没有末行")
			case "blocked":
				ledger.Record(e.ctx, e.db, task.ID, gates.KindResult, "runtime", "外部故障\n交付结论：受阻")
			case "unregistered":
				empty := ""
				ledger.SetFacts(e.ctx, e.db, task.ID, ledger.Facts{PR: &empty}, "runtime")
			case "no_merge":
				e.gh.PRs[0].MergeCommit = ""
			}
			e.sweep()
			got := e.get(task.ID)
			if got.Status == ledger.Done || got.Stage == ledger.StageAccept || got.Stage == ledger.StageReview || got.Stage == ledger.StageMerge {
				t.Fatalf("错误放行 %s %+v", damage, got)
			}
			t.Logf("%s 拒绝：%s", damage, e.lastNote(task.ID))
		})
	}
}

func (e *env) oldMismatch(task ledger.Task, dir string) {
	f, err := gates.Collect(e.ctx, e.gh, dir, "o/r")
	if err != nil {
		e.t.Fatal(err)
	}
	v := gates.Judge(gates.DefaultChecks, f)
	raw, _ := json.Marshal(struct {
		gates.Verdict
		Facts gates.Facts `json:"facts"`
	}{v, f})
	ledger.Record(e.ctx, e.db, task.ID, gates.KindGate, "gates", string(raw))
	gates.Block(e.ctx, e.db, task.ID, "旧 OPEN 关卡错配")
}

func TestMergedRecovery(t *testing.T) {
	for _, word := range []string{"完成", "受阻"} {
		t.Run(word, func(t *testing.T) {
			e := setup(t)
			task, dir := e.mergedRecheck("dsh+gpt")
			reply := "实际资料已核对；仅 OPEN 关卡错配\n交付结论：" + word
			ledger.Record(e.ctx, e.db, task.ID, gates.KindResult, "runtime", reply)
			e.oldMismatch(task, dir)
			in := merge.Body{RestoreMerged: true, Reason: "仅 OPEN 生命周期错配", Evidence: "资料证据已核对"}
			got, err := merge.Deliver(e.ctx, e.db, e.gh, task.ID, in, "u1")
			if err != nil || got.Stage != ledger.StageAccept {
				t.Fatalf("%+v %v", got, err)
			}
			raw, _, _ := gates.Last(e.ctx, e.db, task.ID, gates.KindResult)
			if raw != reply {
				t.Fatal("result 被改写")
			}
			got, err = e.g.Accept(e.ctx, task.ID, "u1")
			if err != nil || got.Status != ledger.Done {
				t.Fatalf("%+v %v", got, err)
			}
			t.Logf("t973/t914 %s形状：恢复仅到验收，result保留，验收后完成", word)
		})
	}
}

func TestMergedRecoveryRejects(t *testing.T) {
	for _, damage := range []string{"dirty", "unpushed", "head", "unfinished", "reason", "evidence", "other_block", "external_block", "unauthorized", "changed_reply"} {
		t.Run(damage, func(t *testing.T) {
			e := setup(t)
			task, dir := e.mergedRecheck("dsh+gpt")
			e.oldMismatch(task, dir)
			in := merge.Body{RestoreMerged: true, Reason: "仅关卡错配", Evidence: "核对资料"}
			actor := "u1"
			switch damage {
			case "dirty":
				e.gh.Write(dir, "dirty", "x")
			case "unpushed":
				e.gh.Must(dir, "push", "origin", "HEAD~1:refs/heads/task-t1", "--force")
			case "head":
				e.gh.Write(dir, "new", "x")
				e.gh.Must(dir, "add", "new")
				e.gh.Must(dir, "commit", "-m", "new")
			case "unfinished":
				ledger.Record(e.ctx, e.db, task.ID, gates.KindResult, "runtime", "交付结论：未完成")
			case "reason":
				in.Reason = ""
			case "evidence":
				in.Evidence = ""
			case "other_block":
				ledger.Record(e.ctx, e.db, task.ID, gates.KindGate, "gates", `{"pass":false,"results":[{"check":"claims_verified","ok":false}]}`)
			case "external_block":
				ledger.Record(e.ctx, e.db, task.ID, gates.KindResult, "runtime", "等待外部审批\n交付结论：受阻")
				raw, _, _ := gates.Last(e.ctx, e.db, task.ID, gates.KindGate)
				ledger.Record(e.ctx, e.db, task.ID, gates.KindGate, "gates", strings.ReplaceAll(raw, `"check":"pr_exists","ok":false`, `"check":"pr_exists","ok":true`))
			case "unauthorized":
				actor = "a99"
			case "changed_reply":
				ledger.Record(e.ctx, e.db, task.ID, gates.KindResult, "runtime", "新外部故障\n交付结论：受阻")
			}
			_, err := merge.Deliver(e.ctx, e.db, e.gh, task.ID, in, actor)
			if err == nil {
				t.Fatal("错误放行", damage)
			}
			if e.state(task.ID) != "blocked/gate" {
				t.Fatal(e.state(task.ID))
			}
			t.Logf("%s 拒绝：%v", damage, err)
		})
	}
}

func TestMergedRecoveryLeaderAndCLI(t *testing.T) {
	e := setup(t)
	task, dir := e.mergedRecheck("dsh+gpt")
	e.oldMismatch(task, dir)
	leader, err := org.AddLeader(e.ctx, e.db, org.NewLeader{Name: "本任务负责人", Workers: []string{"dsh+gpt"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := org.Edit(e.ctx, e.db, task.Org, org.DeptPatch{Leader: &leader.ID}); err != nil {
		t.Fatal(err)
	}
	router := api.NewRouter(nil)
	router.AddAuth(func(token string) (api.Actor, bool) {
		return api.Actor{ID: "a99", Kind: "leader"}, token == "isolated-test"
	})
	merge.Routes(router, &app.Env{DB: e.db})
	server := httptest.NewServer(router)
	defer server.Close()
	data := t.TempDir()
	if err := config.WriteService(config.Paths{Data: data}, config.ServiceInfo{Port: server.Listener.Addr().(*net.TCPAddr).Port}); err != nil {
		t.Fatal(err)
	}
	table := cli.NewTable("atrium", "隔离命令")
	table.Group("task", "任务")
	merge.Commands(table)
	var output bytes.Buffer
	exit := table.Main(e.ctx, []string{"task", "merge", task.ID, "--restore-merged", "--reason", "仅关卡错配", "--evidence", "核对资料", "--json"}, cli.Env{Stdout: &output, Stderr: &output, Getenv: func(k string) string {
		switch k {
		case "ATRIUM_DATA":
			return data
		case "ATRIUM_LEADER_TOKEN":
			return "isolated-test"
		}
		return ""
	}})
	if exit == 0 || !strings.Contains(output.String(), "forbidden") || e.state(task.ID) != "blocked/gate" {
		t.Fatalf("越权 CLI 未拒绝：%d %s", exit, output.String())
	}
	t.Log("实际 CLI 参数→HTTP task merge→恢复权限：管辖外负责人拒绝，任务保持 blocked/gate")
	got, err := merge.Deliver(e.ctx, e.db, e.gh, task.ID, merge.Body{RestoreMerged: true, Reason: "仅关卡错配", Evidence: "核对资料"}, leader.ID)
	if err != nil || got.Stage != ledger.StageAccept {
		t.Fatalf("本负责人不能恢复：%+v %v", got, err)
	}
	t.Log("有权原负责人恢复到待验收")
}

func TestMergedRecheckAcceptRevalidates(t *testing.T) {
	for _, damage := range []string{"dirty", "unpushed", "head", "reply"} {
		t.Run(damage, func(t *testing.T) {
			e := setup(t)
			task, dir := e.mergedRecheck("dsh+gpt")
			e.sweep()
			if e.state(task.ID) != "running/accept" {
				t.Fatal(e.state(task.ID))
			}
			switch damage {
			case "dirty":
				e.gh.Write(dir, "dirty", "x")
			case "unpushed":
				e.gh.Must(dir, "push", "origin", "HEAD~1:refs/heads/task-t1", "--force")
			case "head":
				e.gh.Write(dir, "new", "x")
				e.gh.Must(dir, "add", "new")
				e.gh.Must(dir, "commit", "-m", "new")
				e.gh.Must(dir, "push", "origin", "HEAD")
			case "reply":
				ledger.Record(e.ctx, e.db, task.ID, gates.KindResult, "runtime", "交付结论：未完成")
			}
			_, err := e.g.Accept(e.ctx, task.ID, "u1")
			if err == nil || e.get(task.ID).Status == ledger.Done {
				t.Fatal("验收沿用旧证明", damage, err)
			}
			t.Logf("验收时 %s 拒绝：%v", damage, err)
		})
	}
}
