//go:build !windows

package platform

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPrivatePermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := PrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "token")
	if err := os.WriteFile(path, nil, 0o666); err != nil {
		t.Fatal(err)
	}
	if err := WritePrivateFile(path, []byte("test-only")); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]os.FileMode{dir: 0o700, path: 0o600} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != want {
			t.Fatalf("%s: mode %o, want %o", path, info.Mode().Perm(), want)
		}
	}
}
