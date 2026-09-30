package workers

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestReserveChrome(t *testing.T) {
	home := t.TempDir()
	first, isolated, err := reserveChrome(home)
	if err != nil || isolated || first == nil {
		t.Fatalf("空闲: %v %v", isolated, err)
	}
	defer first.Close()
	second, isolated, err := reserveChrome(home)
	if err != nil || !isolated || second != nil {
		t.Fatalf("被占: %v %v", isolated, err)
	}
	first.Close()
	third, isolated, err := reserveChrome(home)
	if err != nil || isolated || third == nil {
		t.Fatalf("释放: %v %v", isolated, err)
	}
	third.Close()
	// 文件仍在，但没有活锁：不按文件是否存在判定占用。
	if _, err := os.Stat(filepath.Join(home, ".cache", "chrome-devtools-mcp", "chrome-profile.atrium-lock")); err != nil {
		t.Fatal(err)
	}
	for _, isolated := range []bool{false, true} {
		args := chromeArgs(isolated, []string{"--headless"})
		want := []string{"-y", "chrome-devtools-mcp@latest", "--no-usage-statistics"}
		if isolated {
			want = append(want, "--isolated")
		}
		want = append(want, "--headless")
		if !reflect.DeepEqual(args, want) {
			t.Fatal(args)
		}
	}
}

func TestReserveChromeConcurrent(t *testing.T) {
	home := t.TempDir()
	type result struct {
		lock     *os.File
		isolated bool
		err      error
	}
	results := make(chan result, 16)
	start := make(chan struct{})
	for i := 0; i < cap(results); i++ {
		go func() { <-start; lock, isolated, err := reserveChrome(home); results <- result{lock, isolated, err} }()
	}
	close(start)
	owners := 0
	for i := 0; i < cap(results); i++ {
		r := <-results
		if r.err != nil {
			t.Fatal(r.err)
		}
		if r.lock != nil {
			owners++
			defer r.lock.Close()
		}
		if r.isolated != (r.lock == nil) {
			t.Fatal("占用判定与参数不一致")
		}
	}
	if owners != 1 {
		t.Fatalf("同时启动时专用目录占用者 = %d", owners)
	}
}
