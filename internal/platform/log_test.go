package platform

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestOpenLogTailTruncate(t *testing.T) {
	for _, size := range []int{0, logLimit, logLimit + 1} {
		t.Run(strconv.Itoa(size), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "wake.log")
			original := bytes.Repeat([]byte("x"), size)
			if size > logLimit {
				copy(original[size-logTail:], bytes.Repeat([]byte("tail"), logTail/4))
			}
			if err := os.WriteFile(path, original, 0o600); err != nil {
				t.Fatal(err)
			}
			f, err := OpenLog(path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.WriteString("new\n"); err != nil {
				t.Fatal(err)
			}
			if err := f.Close(); err != nil {
				t.Fatal(err)
			}
			want := original
			if size > logLimit {
				want = original[size-logTail:]
			}
			got, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(got, append(want, []byte("new\n")...)) {
				t.Fatalf("截尾及追加不符: size=%d err=%v", len(got), err)
			}
			t.Logf("打开前 %d，追加后 %d 字节，尾部内容吻合", size, len(got))
		})
	}
}
