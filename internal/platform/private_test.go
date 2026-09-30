package platform

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPrivatePaths(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := PrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "token")
	if err := os.WriteFile(path, []byte("old longer content"), 0o666); err != nil {
		t.Fatal(err)
	}
	if err := WritePrivateFile(path, []byte("new")); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "new" {
		t.Fatalf("content = %q, err = %v", got, err)
	}
	if err := WritePrivateFile(dir, []byte("must fail")); err == nil {
		t.Fatal("directory accepted as file")
	}
	if err := PrivateDir(path); err == nil {
		t.Fatal("file accepted as directory")
	}
}
