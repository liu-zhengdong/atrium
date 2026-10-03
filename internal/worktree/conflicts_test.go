package worktree

import (
	"reflect"
	"testing"
)

func TestConflicts(t *testing.T) {
	tracked := []string{"README.md", "sub/a.go", "deep/x/y.txt"}
	for _, c := range []struct {
		name     string
		existing map[string]bool
		want     []string
	}{
		{"不相干的文件", map[string]bool{"keep.txt": false}, nil},
		{"同名目录合并", map[string]bool{"sub": true, "sub/k": false, "deep": true, "deep/x": true}, nil},
		{"同名文件", map[string]bool{"README.md": false}, []string{"README.md"}},
		{"文件挡住目录", map[string]bool{"sub": false, "deep": true, "deep/x": false}, []string{"deep/x", "sub"}},
		{"目录挡住文件", map[string]bool{"README.md": true}, []string{"README.md"}},
	} {
		if got := conflicts(c.existing, tracked); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s：%v，应为 %v", c.name, got, c.want)
		}
	}
}
