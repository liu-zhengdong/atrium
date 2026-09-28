package release

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/gates"
)

// MinMajor：Go 版从 v2 起；更早的 tag 是 TypeScript 版，没有二进制。
const MinMajor = 2

// LatestTag 取仓库 GitHub Release 里最新的 Go 版版本。
func LatestTag(ctx context.Context, r gates.Runner, repo string) (string, error) {
	out, err := r.Run(ctx, "", "gh", "release", "list", "-R", repo, "--json", "tagName", "--limit", "50")
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
		if v, ok := Parse(x.TagName); ok && v[0] >= MinMajor {
			tags = append(tags, x.TagName)
		}
	}
	return Newest(tags), nil
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

// Install 从 GitHub Release 下载本平台二进制替换 exe：旧文件留作 exe.old（手动退回用）。
// 下载放在 exe 同目录，改名不跨文件系统。
func Install(ctx context.Context, r gates.Runner, repo, tag, exe string) error {
	dir, err := os.MkdirTemp(filepath.Dir(exe), ".atrium-update-")
	if err != nil {
		return fmt.Errorf("在 %s 建临时目录失败（没有写权限？）：%w", filepath.Dir(exe), err)
	}
	defer os.RemoveAll(dir)
	asset := Asset(runtime.GOOS, runtime.GOARCH)
	if _, err := r.Run(ctx, "", "gh", "release", "download", tag, "-R", repo, "-p", asset, "-D", dir); err != nil {
		return err
	}
	fresh := filepath.Join(dir, asset)
	if err := os.Chmod(fresh, 0o755); err != nil {
		return err
	}
	old := exe + ".old"
	if err := os.Remove(old); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// 在跑的可执行文件可以改名（Windows 也可以），不能覆盖写：先挪开再放新的。
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(fresh, exe); err != nil {
		return fmt.Errorf("新版本放不进 %s（旧版本在 %s）：%w", exe, old, err)
	}
	return nil
}
