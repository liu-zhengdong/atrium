package release

import (
	"path/filepath"
	"strconv"
	"strings"
)

// 本文件是纯判定：版本比较、资产名、自升级开不开。

// Version 是 vMAJOR.MINOR.PATCH。
type Version [3]int

// Parse 接受 v2.0.1 或 2.0.1；别的（v2-dev、带预发布后缀）不算发版版本。
func Parse(s string) (Version, bool) {
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(s), "v"), ".")
	var v Version
	if len(parts) != 3 {
		return v, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || strconv.Itoa(n) != p {
			return v, false
		}
		v[i] = n
	}
	return v, true
}

// Compare 比两个版本：a 新返回 1，相同 0，a 旧 -1。不是发版版本的算最旧。
func Compare(a, b string) int {
	va, oka := Parse(a)
	vb, okb := Parse(b)
	switch {
	case !oka && !okb:
		return 0
	case !oka:
		return -1
	case !okb:
		return 1
	}
	for i := range va {
		if va[i] != vb[i] {
			if va[i] > vb[i] {
				return 1
			}
			return -1
		}
	}
	return 0
}

// Newest 取一组 tag 里最新的发版版本；没有返回空串。
func Newest(tags []string) string {
	best := ""
	for _, t := range tags {
		if _, ok := Parse(t); ok && (best == "" || Compare(t, best) > 0) {
			best = t
		}
	}
	return best
}

// Asset 是某平台的二进制在 GitHub Release 里的文件名（与 .github/workflows/release.yml 一致）。
func Asset(goos, goarch string) string {
	name := "atrium-" + goos + "-" + goarch
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

// SelfUpgrade 判本实例开不开自升级：只在默认数据目录、且当前是发版版本时开；隔离实例与开发版不动。
func SelfUpgrade(data, defaultData, version string) (bool, string) {
	if filepath.Clean(data) != filepath.Clean(defaultData) {
		return false, "隔离实例（数据目录 " + data + "）不自升级"
	}
	if _, ok := Parse(version); !ok {
		return false, "开发版（" + version + "）不自升级"
	}
	return true, ""
}

// Upgrade 判发版巡检这一轮升不升：本实例开了自升级（默认数据目录、发版版本，见 SelfUpgrade）、
// 没有全局暂停、最新发布比运行中的新，且本进程没在这个版本上升失败过（失败只报一次，不反复重试）。
func Upgrade(current, latest string, enabled, paused bool, failed string) bool {
	return enabled && !paused && latest != failed && Compare(latest, current) > 0
}
