// Package fakegh 是测试用的假 GitHub：真 git + 本地 bare 仓库当远端，gh 的子命令在内存里答。
// 只给 gates、merge、release 的测试用，不进产品路径。
package fakegh

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/gates"
)

// PR 是假 GitHub 上的一个 PR。
type PR struct {
	Number      int
	Head, Base  string
	State       string
	Draft       bool
	Body        string
	MergeCommit string
	Checks      []Check // PR 头提交上的远端 checks；空 = 没配 CI
}

// Check 是一个远端 check 的结论（bucket 取 gh 的值：pass、fail、pending、skipping、cancel）。
type Check struct {
	Name, Bucket, Link string
}

// Release 是假 GitHub 上的一个 release（tag 要另在 bare 仓库里打好）。
type Release struct {
	Tag    string
	Draft  bool
	Assets int
}

// GH 实现 gates.Runner：git 走真的，gh 走假的。
type GH struct {
	T        testing.TB
	Git      *gates.Exec
	Repo     string // o/r
	Bare     string
	Work     string // 假 GitHub 自己做 squash 合并用的克隆
	mu       sync.Mutex
	PRs      []*PR
	Releases []Release // 新的在前，同 GitHub 的 releases 接口
	Calls    []string  // 收到的 gh 调用（空格连接）
}

// New 建一个 bare 远端（main 上一个初始提交，files 是初始文件）。
func New(t testing.TB, files map[string]string) *GH {
	t.Helper()
	root := t.TempDir()
	x := gates.NewExec()
	for k, v := range map[string]string{"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
		"GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": filepath.Join(root, "gitconfig")} {
		x.Env[k] = v
	}
	g := &GH{T: t, Git: x, Repo: "o/r", Bare: filepath.Join(root, "remote.git"), Work: filepath.Join(root, "gh-work")}
	g.Must(root, "init", "--quiet", "--bare", "-b", "main", g.Bare)
	seed := filepath.Join(root, "seed")
	g.Must(root, "clone", "--quiet", g.Bare, seed)
	g.Must(seed, "checkout", "--quiet", "-b", "main")
	for name, body := range files {
		g.Write(seed, name, body)
	}
	g.Write(seed, "README.md", "hi\n")
	g.Must(seed, "add", "-A")
	g.Must(seed, "commit", "--quiet", "-m", "init")
	g.Must(seed, "push", "--quiet", "origin", "main")
	g.Must(root, "clone", "--quiet", g.Bare, g.Work)
	return g
}

// Must 跑 git，出错让测试失败。
func (g *GH) Must(dir string, args ...string) string {
	g.T.Helper()
	out, err := g.Git.Run(context.Background(), dir, "git", args...)
	if err != nil {
		g.T.Fatalf("git %v：%v", args, err)
	}
	return strings.TrimSpace(out)
}

// Write 写一个文件（按需建目录）。
func (g *GH) Write(dir, name, body string) {
	g.T.Helper()
	p := filepath.Join(dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		g.T.Fatal(err)
	}
	mode := os.FileMode(0o644)
	if strings.HasPrefix(name, ".agents/") {
		mode = 0o755
	}
	if err := os.WriteFile(p, []byte(body), mode); err != nil {
		g.T.Fatal(err)
	}
}

// Branch 模拟执行者：克隆到 dir、开分支、提交文件、推送。
func (g *GH) Branch(dir, branch string, files map[string]string) {
	g.T.Helper()
	g.Must(filepath.Dir(dir), "clone", "--quiet", g.Bare, dir)
	g.Must(dir, "checkout", "--quiet", "-b", branch)
	for name, body := range files {
		g.Write(dir, name, body)
	}
	g.Must(dir, "add", "-A")
	g.Must(dir, "commit", "--quiet", "-m", "work on "+branch)
	g.Must(dir, "push", "--quiet", "origin", branch)
}

// Commit 在 main 上直接加一个提交（模拟别人先合入）。
func (g *GH) Commit(files map[string]string) {
	g.T.Helper()
	g.Must(g.Work, "fetch", "--quiet", "origin")
	g.Must(g.Work, "checkout", "--quiet", "-B", "main", "origin/main")
	for name, body := range files {
		g.Write(g.Work, name, body)
	}
	g.Must(g.Work, "add", "-A")
	g.Must(g.Work, "commit", "--quiet", "-m", "other")
	g.Must(g.Work, "push", "--quiet", "origin", "main")
}

// Open 开一个 PR，返回号。
func (g *GH) Open(head, body string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	pr := &PR{Number: len(g.PRs) + 1, Head: head, Base: "main", State: "OPEN", Body: body}
	g.PRs = append(g.PRs, pr)
	return pr.Number
}

func (g *GH) url(n int) string { return fmt.Sprintf("https://github.com/%s/pull/%d", g.Repo, n) }

func (g *GH) head(branch string) string {
	out, err := g.Git.Run(context.Background(), "", "git", "--git-dir", g.Bare, "rev-parse", "refs/heads/"+branch)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

func (g *GH) json(p *PR) map[string]any {
	m := map[string]any{"number": p.Number, "url": g.url(p.Number), "state": p.State, "isDraft": p.Draft, "headRefName": p.Head,
		"headRefOid": g.head(p.Head), "baseRefName": p.Base, "body": p.Body, "mergeCommit": nil}
	if p.MergeCommit != "" {
		m["mergeCommit"] = map[string]string{"oid": p.MergeCommit}
	}
	return m
}

func (g *GH) find(ref string) *PR {
	ref = strings.TrimPrefix(ref, "https://github.com/"+g.Repo+"/pull/")
	for _, p := range g.PRs {
		if fmt.Sprint(p.Number) == ref {
			return p
		}
	}
	return nil
}

func out(v any) (string, error) {
	raw, err := json.Marshal(v)
	return string(raw), err
}

// Run 实现 gates.Runner。
func (g *GH) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	if name != "gh" {
		return g.Git.Run(ctx, dir, name, args...)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.Calls = append(g.Calls, strings.Join(args, " "))
	flag := func(f string) string {
		for i, a := range args {
			if a == f && i+1 < len(args) {
				return args[i+1]
			}
		}
		return ""
	}
	if r := flag("-R"); r != "" && r != g.Repo {
		return "", fmt.Errorf("假 gh：不认识仓库 %s", r)
	}
	if args[0] == "api" && strings.HasPrefix(args[1], "repos/"+g.Repo+"/releases") {
		list := []map[string]any{}
		for _, r := range g.Releases {
			list = append(list, map[string]any{"tag_name": r.Tag, "draft": r.Draft, "assets": make([]struct{}, r.Assets)})
		}
		return out(list)
	}
	switch strings.Join(args[:2], " ") {
	case "repo view":
		return "main\n", nil
	case "repo clone":
		return g.Git.Run(ctx, "", "git", "clone", "--quiet", g.Bare, args[3])
	case "pr list":
		list := []map[string]any{}
		for _, p := range g.PRs {
			if p.Head == flag("--head") {
				list = append(list, g.json(p))
			}
		}
		return out(list)
	case "pr view":
		p := g.find(args[2])
		if p == nil {
			return "", fmt.Errorf("假 gh：没有 PR %s", args[2])
		}
		return out(g.json(p))
	case "pr checks":
		p := g.find(args[2])
		if p == nil {
			return "", fmt.Errorf("假 gh：没有 PR %s", args[2])
		}
		list := []map[string]string{}
		for _, c := range p.Checks {
			list = append(list, map[string]string{"name": c.Name, "bucket": c.Bucket, "link": c.Link})
		}
		return out(list)
	case "pr merge":
		p := g.find(args[2])
		if p == nil || p.State != "OPEN" || p.Draft {
			return "", fmt.Errorf("假 gh：PR %s 不能合", args[2])
		}
		if want := flag("--match-head-commit"); want != g.head(p.Head) {
			return "", fmt.Errorf("假 gh：头提交 %s 与 --match-head-commit %s 不一致", g.head(p.Head), want)
		}
		for _, a := range [][]string{{"fetch", "--quiet", "origin"}, {"checkout", "--quiet", "-B", p.Base, "origin/" + p.Base},
			{"merge", "--quiet", "--squash", "origin/" + p.Head}, {"commit", "--quiet", "-m", fmt.Sprintf("squash #%d", p.Number)},
			{"push", "--quiet", "origin", p.Base}} {
			if _, err := g.Git.Run(ctx, g.Work, "git", a...); err != nil {
				return "", err
			}
		}
		sha, _ := g.Git.Run(ctx, g.Work, "git", "rev-parse", "HEAD")
		p.State, p.MergeCommit = "MERGED", strings.TrimSpace(sha)
		return "", nil
	}
	return "", fmt.Errorf("假 gh：不支持 %v", args)
}
