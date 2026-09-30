package platform

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestFileLockProcess(t *testing.T) {
	if path := os.Getenv("ATRIUM_TEST_PROFILE_LOCK"); path != "" {
		lock, err := TryFileLock(path)
		if err != nil || lock == nil {
			os.Exit(2)
		}
		defer lock.Close()
		fmt.Println("locked")
		io.Copy(io.Discard, os.Stdin)
		return
	}
	for _, crash := range []bool{false, true} {
		t.Run(fmt.Sprint("crash=", crash), func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "lock")
			input, feed, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer input.Close()
			defer feed.Close()
			output, report, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer output.Close()
			defer report.Close()
			cmd, err := Start(Spec{Path: os.Args[0], Args: []string{"-test.run=^TestFileLockProcess$"}, Env: map[string]string{"ATRIUM_TEST_PROFILE_LOCK": path}, Stdin: input, Stdout: report, Stderr: report})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { cmd.Process.Kill(); cmd.Wait() }()
			if line, err := bufio.NewReader(output).ReadString('\n'); err != nil || line != "locked\n" {
				t.Fatalf("%q %v", line, err)
			}
			lock, err := TryFileLock(path)
			if err != nil || lock != nil {
				t.Fatalf("活进程占用: %v %v", lock, err)
			}
			if crash {
				cmd.Process.Kill()
			} else {
				feed.Close()
			}
			cmd.Wait()
			lock, err = TryFileLock(path)
			if err != nil || lock == nil {
				t.Fatalf("退出后的残留文件: %v %v", lock, err)
			}
			lock.Close()
		})
	}
}
