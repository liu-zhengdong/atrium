package gates

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
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

// ParseSlug 把任务的仓库写法换成 gh 认的 owner/name（纯函数）：owner/name 原样；
// https://github.com/o/r(.git)、git@github.com:o/r(.git)、ssh://git@github.com/o/r 取出 o/r。认不出返回 false。
func ParseSlug(repo string) (string, bool) {
	s := strings.TrimSpace(repo)
	switch {
	case strings.HasPrefix(s, "git@"):
		_, s, _ = strings.Cut(s, ":")
	case strings.Contains(s, "://"):
		_, s, _ = strings.Cut(s, "://")
		_, s, _ = strings.Cut(s, "/")
	}
	s = strings.TrimSuffix(strings.TrimSuffix(s, "/"), ".git")
	owner, name, ok := strings.Cut(s, "/")
	if !ok || owner == "" || name == "" || strings.ContainsAny(name, "/ ") || strings.Contains(s, "..") || strings.HasPrefix(owner, "-") {
		return "", false
	}
	return owner + "/" + name, true
}

// Slug 取任务仓库在 GitHub 上的 owner/name：本机克隆的绝对路径读它的 origin 地址，其余按 ParseSlug。
func Slug(ctx context.Context, r Runner, repo string) (string, error) {
	if filepath.IsAbs(repo) {
		url, err := r.Run(ctx, repo, "git", "remote", "get-url", "origin")
		if err != nil {
			return "", err
		}
		repo = strings.TrimSpace(url)
	}
	slug, ok := ParseSlug(repo)
	if !ok {
		return "", fmt.Errorf("仓库 %q 不是 GitHub 仓库（owner/name 或 GitHub 地址），查不了 PR", repo)
	}
	return slug, nil
}

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
	f, git, err := collectBase(ctx, r, dir, repo)
	if err != nil {
		return f, err
	}
	remote, err := git("ls-remote", "origin", "refs/heads/"+f.Branch)
	if err != nil {
		return f, err
	}
	f.Pushed = remote != "" && strings.Fields(remote)[0] == f.Head
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

// collectBase 查工作树相对 GitHub 默认分支（先 fetch）的事实：分支、未提交的改动、新提交、改动规模；不看推送与 PR。
func collectBase(ctx context.Context, r Runner, dir, repo string) (Facts, gitFunc, error) {
	f, git, err := branchFacts(ctx, r, dir)
	if err != nil {
		return f, git, err
	}
	if f.Base, err = DefaultBranch(ctx, r, repo); err != nil {
		return f, git, err
	}
	if _, err = git("fetch", "--quiet", "origin", f.Base); err != nil {
		return f, git, err
	}
	return f, git, f.compare(git, "origin/"+f.Base)
}

// CollectLocal 查本机交付的事实：分支、未提交的改动、比本机主分支（LocalBase）多几个提交、改动规模；不碰远端。
func CollectLocal(ctx context.Context, r Runner, dir, repo string) (Facts, error) {
	f, git, err := branchFacts(ctx, r, dir)
	if err != nil {
		return f, err
	}
	if f.Base, err = LocalBase(ctx, r, repo); err != nil {
		return f, err
	}
	return f, f.compare(git, f.Base)
}

// LocalBase 是本机仓库的主分支：主工作树当前所在的分支。
func LocalBase(ctx context.Context, r Runner, repo string) (string, error) {
	out, err := r.Run(ctx, repo, "git", "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		return "", fmt.Errorf("本机仓库 %s 的主工作树不在分支上：%w", repo, err)
	}
	return strings.TrimSpace(out), nil
}

type gitFunc func(args ...string) (string, error)

// branchFacts 读工作树所在的分支与头提交；返回在这个工作树里跑 git 的函数。
func branchFacts(ctx context.Context, r Runner, dir string) (Facts, gitFunc, error) {
	f := Facts{Dir: dir}
	git := func(args ...string) (string, error) {
		out, err := r.Run(ctx, dir, "git", append([]string{"--no-optional-locks"}, args...)...)
		return strings.TrimSpace(out), err
	}
	var err error
	if f.Branch, err = git("rev-parse", "--abbrev-ref", "HEAD"); err != nil {
		return f, git, err
	}
	if f.Branch == "HEAD" {
		return f, git, fmt.Errorf("工作树 %s 不在分支上（detached HEAD）", dir)
	}
	f.Head, err = git("rev-parse", "HEAD")
	return f, git, err
}

// compare 查工作树相对 base 的事实：未提交的文件、新提交数、改动规模。
func (f *Facts) compare(git gitFunc, base string) error {
	status, err := git("status", "--porcelain")
	if err != nil {
		return err
	}
	for _, line := range strings.Split(status, "\n") {
		if len(line) > 3 {
			f.Dirty = append(f.Dirty, strings.TrimSpace(line[3:]))
		}
	}
	count, err := git("rev-list", "--count", base+"..HEAD")
	if err != nil {
		return err
	}
	f.Ahead, _ = strconv.Atoi(count)
	numstat, err := git("diff", "--numstat", base+"...HEAD")
	if err != nil {
		return err
	}
	f.Numstat = ParseNumstat(numstat)
	f.Diff = DiffText(f.Numstat)
	return nil
}
