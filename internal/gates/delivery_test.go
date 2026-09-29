package gates

import "testing"

func TestPick(t *testing.T) {
	cases := []struct {
		repo, origin string
		choice       bool
		want         string
	}{
		{"/src/site", "", false, "local"},                       // 本机仓库、没有远程
		{"/src/site", "/backup/site.git", false, "local"},       // 远程不是 GitHub
		{"/src/app", "git@github.com:o/r.git", false, "pr"},     // 本机克隆、origin 在 GitHub
		{"/src/app", "https://github.com/o/r.git", false, "pr"}, //
		{"o/r", "", false, "pr"},                                // owner/name
		{"https://github.com/o/r.git", "", false, "pr"},         // 克隆地址
		{"", "", false, "message"},                              // 没有仓库
		{"", "", true, "choice"},                                // 没有仓库、有 choice.json
		{"/src/site", "", true, "local"},                        // 有仓库时不看 choice.json
	}
	for _, c := range cases {
		if got := pick(c.repo, c.origin, c.choice).Name; got != c.want {
			t.Errorf("pick(%q, %q, %v) = %s，应为 %s", c.repo, c.origin, c.choice, got, c.want)
		}
	}
}
