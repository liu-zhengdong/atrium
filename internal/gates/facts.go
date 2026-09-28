package gates

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// ghPR 是 gh 的 PR JSON（pr list / pr view 的字段）。
type ghPR struct {
	Number      int    `json:"number"`
	URL         string `json:"url"`
	State       string `json:"state"`
	HeadRefName string `json:"headRefName"`
	HeadRefOid  string `json:"headRefOid"`
	BaseRefName string `json:"baseRefName"`
	Body        string `json:"body"`
	MergeCommit *struct {
		Oid string `json:"oid"`
	} `json:"mergeCommit"`
}

func (p ghPR) pr() PR {
	return PR{Number: p.Number, URL: p.URL, State: p.State, Head: p.HeadRefName, HeadID: p.HeadRefOid, Body: p.Body}
}

// PRFields 是 gh --json 要的字段。
const PRFields = "number,url,state,headRefName,headRefOid,baseRefName,body,mergeCommit"

// DefaultBranch 问 GitHub 仓库的默认分支。
func DefaultBranch(ctx context.Context, r Runner, repo string) (string, error) {
	out, err := r.Run(ctx, "", "gh", "repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name")
	if err != nil {
		return "", err
	}
	name := strings.TrimSpace(out)
	if name == "" {
		return "", fmt.Errorf("gh repo view %s 没给出默认分支", repo)
	}
	return name, nil
}

// PRInfo 是合入与上线要的 PR 事实。
type PRInfo struct {
	PR
	Base        string
	MergeCommit string
}

// ViewPR 按号或链接查一个 PR。
func ViewPR(ctx context.Context, r Runner, repo, ref string) (PRInfo, error) {
	out, err := r.Run(ctx, "", "gh", "pr", "view", ref, "-R", repo, "--json", PRFields)
	if err != nil {
		return PRInfo{}, err
	}
	var p ghPR
	if err := json.Unmarshal([]byte(out), &p); err != nil {
		return PRInfo{}, fmt.Errorf("gh pr view 输出不是 JSON：%w", err)
	}
	info := PRInfo{PR: p.pr(), Base: p.BaseRefName}
	if p.MergeCommit != nil {
		info.MergeCommit = p.MergeCommit.Oid
	}
	return info, nil
}

// Collect 在执行者的工作树里查事实：分支、提交、推送、改动规模、PR 与正文「端到端验证」一节。
func Collect(ctx context.Context, r Runner, dir, repo string) (Facts, error) {
	f := Facts{Dir: dir}
	git := func(args ...string) (string, error) {
		out, err := r.Run(ctx, dir, "git", append([]string{"--no-optional-locks"}, args...)...)
		return strings.TrimSpace(out), err
	}
	var err error
	if f.Branch, err = git("rev-parse", "--abbrev-ref", "HEAD"); err != nil {
		return f, err
	}
	if f.Branch == "HEAD" {
		return f, fmt.Errorf("工作树 %s 不在分支上（detached HEAD）", dir)
	}
	if f.Head, err = git("rev-parse", "HEAD"); err != nil {
		return f, err
	}
	if f.Base, err = DefaultBranch(ctx, r, repo); err != nil {
		return f, err
	}
	if _, err = git("fetch", "--quiet", "origin", f.Base); err != nil {
		return f, err
	}
	remote, err := git("ls-remote", "origin", "refs/heads/"+f.Branch)
	if err != nil {
		return f, err
	}
	f.Pushed = remote != "" && strings.Fields(remote)[0] == f.Head
	status, err := git("status", "--porcelain")
	if err != nil {
		return f, err
	}
	for _, line := range strings.Split(status, "\n") {
		if len(line) > 3 {
			f.Dirty = append(f.Dirty, strings.TrimSpace(line[3:]))
		}
	}
	count, err := git("rev-list", "--count", "origin/"+f.Base+"..HEAD")
	if err != nil {
		return f, err
	}
	f.Ahead, _ = strconv.Atoi(count)
	numstat, err := git("diff", "--numstat", "origin/"+f.Base+"...HEAD")
	if err != nil {
		return f, err
	}
	f.Numstat = ParseNumstat(numstat)
	f.Diff = DiffText(f.Numstat)
	out, err := r.Run(ctx, "", "gh", "pr", "list", "-R", repo, "--head", f.Branch, "--state", "all",
		"--json", PRFields, "--limit", "5")
	if err != nil {
		return f, err
	}
	var prs []ghPR
	if err := json.Unmarshal([]byte(out), &prs); err != nil {
		return f, fmt.Errorf("gh pr list 输出不是 JSON：%w", err)
	}
	for _, p := range prs {
		if f.PR == nil || (p.State == "OPEN" && f.PR.State != "OPEN") {
			pr := p.pr()
			f.PR = &pr
		}
	}
	if f.PR != nil {
		f.E2E = Section(f.PR.Body, "端到端验证")
	}
	return f, nil
}
