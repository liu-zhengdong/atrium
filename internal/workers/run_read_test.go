package workers

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRawLogBoundaries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.log")
	for _, text := range []string{"", "error without newline", strings.Repeat("中", 100000), strings.Repeat("a", logChunk+100) + "错误"} {
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		var all strings.Builder
		var offset int64
		for {
			part, next, err := ReadRawLog(path, offset)
			if err != nil {
				t.Fatal(err)
			}
			if len(part) > logChunk {
				t.Fatal("块超限")
			}
			if part == "" {
				break
			}
			if next <= offset {
				t.Fatal("读取不前进")
			}
			all.WriteString(part)
			offset = next
		}
		if all.String() != text {
			t.Fatal("原文不完整")
		}
	}
	if err := os.WriteFile(path, []byte{0xff}, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReadRawLog(path, 0); err == nil {
		t.Fatal("损坏编码被静默替换")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReadRawLog(path, 0); !os.IsNotExist(err) {
		t.Fatalf("缺文件错误被吞掉 %v", err)
	}
}
