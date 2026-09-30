package release

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/release/selfupdate"
)

// MinMajor：Go 版从 v2 起；更早的 tag 是 TypeScript 版，没有二进制。
const MinMajor = 2

// LatestTag 取仓库 GitHub Release 里最新的 Go 版版本。不看草稿：发版工作流的 gh release create 带文件时先建草稿、
// 六个平台的文件都传完才发布，所以看得到的版本本平台与远程代理的平台都下得到，不用等资产传完。
func LatestTag(ctx context.Context, r gates.Runner, repo string) (string, error) {
	out, err := r.Run(ctx, "", "gh", "release", "list", "-R", repo, "--exclude-drafts", "--json", "tagName", "--limit", "50")
	if err != nil {
		return "", err
	}
	var list []struct {
		TagName string `json:"tagName"`
	}
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		return "", fmt.Errorf("gh release list 输出不是 JSON：%w", err)
	}
	var tags []string
	for _, x := range list {
		if v, ok := selfupdate.Parse(x.TagName); ok && v[0] >= MinMajor {
			tags = append(tags, x.TagName)
		}
	}
	return selfupdate.Newest(tags), nil
}

// Contains 判提交 sha 是否已包含在 tag 里（GitHub compare：sha 落后或等于 tag）。
func Contains(ctx context.Context, r gates.Runner, repo, tag, sha string) (bool, error) {
	if tag == "" || sha == "" {
		return false, nil
	}
	out, err := r.Run(ctx, "", "gh", "api", "repos/"+repo+"/compare/"+tag+"..."+sha, "--jq", ".status")
	if err != nil {
		return false, err
	}
	s := strings.TrimSpace(out)
	return s == "identical" || s == "behind", nil
}
