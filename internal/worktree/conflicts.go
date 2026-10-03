package worktree

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// conflicts 判已有路径与要检出的跟踪文件哪些互相占位（纯函数）：同名文件，或一边是文件、另一边要它当目录。
// existing 的键是用 / 分隔的相对路径，值为是否目录。两边都是目录的不算冲突。
// foldCase 为真时按目标文件系统不区分大小写的等价规则比对（Windows 与默认的 macOS 如此）。
func conflicts(existing map[string]bool, tracked []string, foldCase bool) []string {
	key := func(p string) string {
		if foldCase {
			return strings.ToLower(p)
		}
		return p
	}
	parents := map[string]bool{}
	files := map[string]bool{}
	for _, p := range tracked {
		files[key(p)] = true
		for i := range len(p) {
			if p[i] == '/' {
				parents[key(p[:i])] = true
			}
		}
	}
	var out []string
	for p, isDir := range existing {
		k := key(p)
		if files[k] || (!isDir && parents[k]) {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

// caseInsensitive 探测目录所在文件系统是否不区分大小写：在目录里放一个临时文件，看它的大写名能否命中。
// 探测不了（目录还不存在、不可写）按区分大小写处理；真正的写入随后仍由文件系统判定，最坏是拒绝而不是漏判。
func caseInsensitive(dir string) bool {
	f, err := os.CreateTemp(dir, ".case-probe-")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	defer os.Remove(name)
	_, err = os.Stat(filepath.Join(dir, strings.ToUpper(filepath.Base(name))))
	return err == nil
}

// listTree 列出 dir 下所有路径（不跟随符号链接，符号链接按文件算）。
func listTree(dir string) (map[string]bool, error) {
	out := map[string]bool{}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == dir {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		out[filepath.ToSlash(rel)] = d.IsDir()
		return nil
	})
	return out, err
}

func splitZ(s string) []string {
	var out []string
	for _, f := range strings.Split(s, "\x00") {
		if f != "" {
			out = append(out, f)
		}
	}
	return out
}
