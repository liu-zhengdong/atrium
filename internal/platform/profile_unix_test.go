//go:build !windows

package platform

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestChromeProfileBusy(t *testing.T) {
	profile := t.TempDir()
	host, err := os.Hostname()
	if err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(profile, "SingletonLock")
	for _, tc := range []struct {
		target string
		busy   bool
	}{
		{"", false}, {host + "-" + strconv.Itoa(os.Getpid()), true}, {host + "-2147483647", false}, {"another-host-123", true},
	} {
		os.Remove(lock)
		if tc.target != "" {
			if err := os.Symlink(tc.target, lock); err != nil {
				t.Fatal(err)
			}
		}
		busy, err := ChromeProfileBusy(profile)
		if err != nil || busy != tc.busy {
			t.Fatalf("%q: %v %v", tc.target, busy, err)
		}
	}
}
