package gates

import (
	"path/filepath"
	"testing"
)

func TestPick(t *testing.T) {
	root := t.TempDir() // 本机规则下的绝对路径：Windows 上 /src/site 没有盘符，不算绝对路径
	site, app, blog := filepath.Join(root, "site"), filepath.Join(root, "app"), filepath.Join(root, "blog")
	cases := []struct {
		repo, dir, origin string
		changed, choice   bool
		want              string
	}{
		{site, "", "", true, false, "local"},                       // 本机仓库、没有远程
		{site, "", "/backup/site.git", true, false, "local"},       // 远程不是 GitHub
		{app, "", "git@github.com:o/r.git", true, false, "pr"},     // 本机克隆、origin 在 GitHub
		{app, "", "https://github.com/o/r.git", true, false, "pr"}, //
		{"o/r", "", "", true, false, "pr"},                         // owner/name
		{"https://github.com/o/r.git", "", "", true, false, "pr"},  // 克隆地址
		{"", "", "", true, false, "message"},                       // 没有仓库
		{"", "", "", true, true, "choice"},                         // 没有仓库、有 choice.json
		{site, "", "", true, true, "local"},                        // 有仓库时不看 choice.json
		{"", blog, "", true, false, "dir"},                         // 只有工作地点
		{"", blog, "", true, true, "dir"},                          // 有工作地点时不看 choice.json
		{site, "", "", false, false, "message"},                    // 本机仓库、工作树没改动：按没有仓库交
		{"o/r", "", "", false, false, "message"},                   // GitHub 仓库、工作树没改动：不要 PR
		{site, "", "", false, true, "message"},                     // 没改动也不看 choice.json
	}
	for _, c := range cases {
		if got := pick(c.repo, c.dir, c.origin, c.changed, c.choice).Name; got != c.want {
			t.Errorf("pick(%q, %q, %q, %v, %v) = %s，应为 %s", c.repo, c.dir, c.origin, c.changed, c.choice, got, c.want)
		}
	}
}
