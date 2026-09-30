// Package merge 是合入队列：串行 rebase 到最新默认分支 → 目标仓库快检查（.agents/check）→
// gh pr merge --squash --match-head-commit。冲突或检查没过交回原执行者，第三次转受阻。
//
// 命令：task merge（登记亲手做的 PR，或放行受阻的交付，都进合入队列）。
// 快检查进程登记给 watch（Role check），10 分钟没输出由 watch 结束，这里判交回还是重跑（check.go）。结果经 ledger.Apply(Land / Bounce) 记录结果：合入、上线是 pr 交付方式的应用步骤。
package merge

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/release"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Module 是本包接入点。
func Module() app.Module {
	return app.Module{Name: "merge", Commands: Commands, Routes: Routes,
		Run: func(ctx context.Context, env *app.Env) error {
			rel := release.ConfigFor(env.Paths, env.Port)
			q := &Queue{DB: env.DB, Pause: env.Pause, R: gates.NewExec(), Log: env.Log,
				Dir: filepath.Join(env.Paths.Data, "merge"), NeedRelease: rel.Tracks}
			return q.Loop(ctx)
		}}
}

func Commands(t *cli.Table) {
	t.Add(cli.Command{Path: "task merge", Args: "<tN>", Summary: "放进合入队列：登记亲手做的 PR（--pr），或放行受阻的交付",
		Flags: []cli.Flag{
			{Name: "pr", Value: "号或链接", Help: "登记这件任务的 PR（没登记过时必填）"},
			{Name: "repo", Value: "owner/name", Help: "PR 所在仓库（缺省取任务的仓库或 PR 链接）"},
		},
		Run: func(c *cli.Ctx) error {
			id, err := c.Arg(0, "任务短号 tN")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			var t ledger.Task
			if err := c.Call("POST", "/api/tasks/"+id+"/merge", Body{PR: c.Str("pr"), Repo: c.Str("repo")}, &t); err != nil {
				return err
			}
			if t.Stage == ledger.StageAccept {
				return c.Done(t, fmt.Sprintf("%s 已登记 %s，部门的验收人要先验收", t.ID, t.PR), "atrium task show "+t.ID)
			}
			text, next, err := events.AsyncNext(c, fmt.Sprintf("%s 已进合入队列（%s，%s）", t.ID, t.Repo, t.PR), "atrium task wait "+t.ID)
			if err != nil {
				return err
			}
			return c.Done(t, text, next)
		}})
}

// Body 是 POST /api/tasks/{id}/merge。
type Body struct {
	PR   string `json:"pr,omitempty"`
	Repo string `json:"repo,omitempty"`
}

var prURL = regexp.MustCompile(`^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/(\d+)/?$`)
var repoName = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// ParsePR 把 --pr 解析成仓库与号：链接带仓库；「12」「#12」只有号。纯函数。
func ParsePR(ref string) (repo string, number int, err error) {
	ref = strings.TrimSpace(ref)
	if m := prURL.FindStringSubmatch(ref); m != nil {
		n, _ := strconv.Atoi(m[2])
		return m[1], n, nil
	}
	n, err := strconv.Atoi(strings.TrimPrefix(ref, "#"))
	if err != nil || n <= 0 {
		return "", 0, api.Usage("--pr: 应为 PR 号或 https://github.com/owner/name/pull/N 链接，收到 %q", ref)
	}
	return "", n, nil
}

func Routes(r *api.Router, env *app.Env) {
	x := gates.NewExec()
	r.Handle("POST /api/tasks/{id}/merge", func(q *api.Req) (any, error) {
		id, err := q.Ref("id", "t")
		if err != nil {
			return nil, err
		}
		var in Body
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return Deliver(q.Context(), env.DB, x, id, in, q.Actor.ID)
	})
}

// Deliver 把任务放进合入队列：登记 PR（给了的话）、核对 PR 开着、Apply(Deliver)。
// 放行的人判不了这个部门的验收（负责人碰上验收人是用户的部门）时，先停在等验收。
func Deliver(ctx context.Context, db *store.DB, r gates.Runner, id string, in Body, actor string) (ledger.Task, error) {
	t, err := ledger.Get(ctx, db, id)
	if err != nil {
		return t, err
	}
	ev := ledger.Event{Kind: ledger.Deliver, Land: ledger.StageMerge}
	if who, _, err := org.Acceptor(ctx, db, t.Org); err != nil {
		return t, err
	} else if who != org.AcceptAuto && !org.MayAccept(actor, who) {
		ev.AcceptBy = who
	}
	if _, err := ledger.Transition(ledger.State{Status: t.Status, Stage: t.Stage}, ev); err != nil {
		return t, api.Conflict("%s：%v", id, err).WithNext("atrium task show " + id)
	}
	repo, ref := t.Repo, t.PR
	if repo != "" {
		if repo, err = gates.Slug(ctx, r, repo); err != nil {
			return t, api.Usage("任务的仓库：%v", err).WithNext("atrium task merge " + id + " --repo owner/name")
		}
	}
	own := repo
	if in.PR != "" {
		fromURL, n, err := ParsePR(in.PR)
		if err != nil {
			return t, err
		}
		ref = strconv.Itoa(n)
		if fromURL != "" {
			repo = fromURL
		}
	}
	if in.Repo != "" {
		repo = in.Repo
	}
	if !repoName.MatchString(repo) {
		return t, api.Usage("--repo: 应为 owner/name，收到 %q", repo).WithNext("atrium task merge " + id + " --repo owner/name")
	}
	if ref == "" {
		return t, api.Usage("--pr: %s 还没有 PR，给出 PR 号或链接", id).WithNext("atrium task merge " + id + " --pr <号或链接>")
	}
	pr, err := gates.ViewPR(ctx, r, repo, ref)
	if err != nil {
		return t, api.Usage("--pr: 在 %s 查不到 PR %s：%v", repo, ref, err)
	}
	if pr.State != "OPEN" {
		return t, api.Conflict("PR #%d 状态是 %s，不是开着的", pr.Number, pr.State)
	}
	if repo != own {
		if _, err := ledger.Edit(ctx, db, id, ledger.Patch{Repo: &repo}, actor); err != nil {
			return t, err
		}
	}
	if err := ledger.SetFacts(ctx, db, id, ledger.Facts{PR: &pr.URL}, actor); err != nil {
		return t, err
	}
	note := "进合入队列：" + pr.URL
	if ev.AcceptBy != "" {
		note = "登记 " + pr.URL + "，等验收：atrium task accept " + id
	}
	return ledger.Apply(ctx, db, id, ev, actor, note)
}
