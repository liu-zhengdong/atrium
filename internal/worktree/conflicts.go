package worktree

import (
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
)

// conflicts 判已有路径与要检出的跟踪文件哪些互相占位（纯函数）：同名文件，或一边是文件、另一边要它当目录。
// existing 的键是用 / 分隔的相对路径，值为是否目录。两边都是目录的不算冲突。
func conflicts(existing map[string]bool, tracked []string) []string {
	parents := map[string]bool{}
	files := map[string]bool{}
	for _, p := range tracked {
		files[p] = true
		for i := range len(p) {
			if p[i] == '/' {
				parents[p[:i]] = true
			}
		}
	}
	var out []string
	for p, isDir := range existing {
		if files[p] || (!isDir && parents[p]) {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
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
