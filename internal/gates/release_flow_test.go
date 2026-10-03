package gates_test

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/gates/fakegh"
	"github.com/liu-zhengdong/atrium/internal/ledger"
)

const releaseDetail = "目标：发 1.0.0\n\n授权（k52）：本任务已授权发布动作——打 tag、触发与等待 Actions、上传附件与更新清单。\n"

// 发布授权任务（t963 的形状）：执行者按授权合入了自己的 PR，交付检查不再要开着的 PR，改查 release；
// 过了不进合入队列，直接完成。release 没发出来交回并写原因。
func TestGateReleaseAuthorized(t *testing.T) {
	cases := []struct {
		name     string
		merge    bool
		releases func(e *env) []fakegh.Release
		status   ledger.Status
		want     string
	}{
		{"合入且已发布带附件", true, func(e *env) []fakegh.Release {
			e.tag("v1.0.0")
			return []fakegh.Release{{Tag: "v1.0.0", Assets: 3}}
		}, ledger.Done, "release_published"},
		{"合入但没发 release", true, func(*env) []fakegh.Release { return nil }, ledger.Queued, "没有包含 PR #1 合入提交"},
		{"release 是草稿", true, func(e *env) []fakegh.Release {
			e.tag("v1.0.0")
			return []fakegh.Release{{Tag: "v1.0.0", Draft: true, Assets: 3}}
		}, ledger.Queued, "没有包含"},
		{"release 的 tag 不含合入提交", true, func(e *env) []fakegh.Release {
			e.gh.Must(e.gh.Bare, "tag", "v0.9.0", "main~1")
			return []fakegh.Release{{Tag: "v0.9.0", Assets: 3}}
		}, ledger.Queued, "没有包含"},
		{"附件为空", true, func(e *env) []fakegh.Release {
			e.tag("v1.0.0")
			return []fakegh.Release{{Tag: "v1.0.0"}}
		}, ledger.Queued, "附件为空"},
		{"PR 还没合入", false, func(*env) []fakegh.Release { return nil }, ledger.Queued, "未合入"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := setup(t)
			dir := filepath.Join(t.TempDir(), "wt")
			e.gh.Branch(dir, "t1-work", map[string]string{"VERSION": "1.0.0\n"})
			n := e.gh.Open("t1-work", goodBody)
			if c.merge {
				head := e.gh.Must(dir, "rev-parse", "HEAD")
				if _, err := e.gh.Run(e.ctx, "", "gh", "pr", "merge", "1", "-R", "o/r", "--match-head-commit", head); err != nil {
					t.Fatal(err)
				}
			}
			e.gh.Releases = c.releases(e)
			task, err := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "发版", Repo: "o/r", Detail: releaseDetail}, "u1")
			if err != nil {
				t.Fatal(err)
			}
			e.start(task.ID, "codex+gpt")
			ledger.Record(e.ctx, e.db, task.ID, gates.KindWorktree, "dispatch", `{"host":"h1","dir":"`+filepath.ToSlash(dir)+`"}`)
			e.exit(task.ID)
			e.sweep()
			got := e.get(task.ID)
			if got.Status != c.status || got.Stage == ledger.StageMerge {
				t.Fatalf("应为 %s 且不进合入队列：%+v；%s", c.status, got, e.lastNote(task.ID))
			}
			if note := e.lastNote(task.ID); !strings.Contains(note, c.want) || strings.Contains(note, "pr_exists") {
				t.Fatalf("经历应含 %q、不提 pr_exists：%s", c.want, note)
			}
			if c.status == ledger.Done && !strings.HasSuffix(got.PR, fmt.Sprintf("/pull/%d", n)) {
				t.Fatalf("应登记 PR：%+v", got)
			}
		})
	}
}

// 常规任务（详述没有授权行）PR 合入了照旧按 pr_exists 交回：常规路径不变。
func TestGateMergedPRWithoutAuthorization(t *testing.T) {
	e := setup(t)
	dir := filepath.Join(t.TempDir(), "wt")
	e.gh.Branch(dir, "t1-work", map[string]string{"a.go": "package a\n"})
	e.gh.Open("t1-work", goodBody)
	head := e.gh.Must(dir, "rev-parse", "HEAD")
	if _, err := e.gh.Run(e.ctx, "", "gh", "pr", "merge", "1", "-R", "o/r", "--match-head-commit", head); err != nil {
		t.Fatal(err)
	}
	e.tag("v1.0.0")
	e.gh.Releases = []fakegh.Release{{Tag: "v1.0.0", Assets: 3}}
	task := e.delivered("做事", "codex+gpt", dir)
	e.sweep()
	if got := e.get(task.ID); got.Status != ledger.Queued || !strings.Contains(e.lastNote(task.ID), "pr_exists") {
		t.Fatalf("常规任务合入的 PR 应按 pr_exists 交回：%+v；%s", got, e.lastNote(task.ID))
	}
}

// tag 在假 GitHub 的 main 头上打一个 tag。
func (e *env) tag(name string) {
	e.t.Helper()
	e.gh.Must(e.gh.Bare, "tag", name, "main")
}
