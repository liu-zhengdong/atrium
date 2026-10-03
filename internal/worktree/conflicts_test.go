package worktree

import (
	"os"
	"reflect"
	"testing"
)

func TestConflicts(t *testing.T) {
	tracked := []string{"README.md", "sub/a.go", "deep/x/y.txt"}
	for _, c := range []struct {
		name     string
		existing map[string]bool
		foldCase bool
		want     []string
	}{
		{"不相干的文件", map[string]bool{"keep.txt": false}, false, nil},
		{"同名目录合并", map[string]bool{"sub": true, "sub/k": false, "deep": true, "deep/x": true}, false, nil},
		{"同名文件", map[string]bool{"README.md": false}, false, []string{"README.md"}},
		{"文件挡住目录", map[string]bool{"sub": false, "deep": true, "deep/x": false}, false, []string{"deep/x", "sub"}},
		{"目录挡住文件", map[string]bool{"README.md": true}, false, []string{"README.md"}},
		{"区分大小写时大小写不同不冲突", map[string]bool{"readme.md": false}, false, nil},
		{"大小写不敏感时大小写不同是同一个文件", map[string]bool{"readme.md": false}, true, []string{"readme.md"}},
		{"大小写不敏感时目录也按大小写等价挡文件", map[string]bool{"readme.md": true}, true, []string{"readme.md"}},
		{"大小写不敏感时不相干仍不冲突", map[string]bool{"keep.txt": false}, true, nil},
	} {
		if got := conflicts(c.existing, tracked, c.foldCase); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s：%v，应为 %v", c.name, got, c.want)
		}
	}
}

// 探测不留下文件。
func TestCaseInsensitiveLeavesNoFile(t *testing.T) {
	dir := t.TempDir()
	caseInsensitive(dir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("探测留下文件：%v", entries)
	}
}
