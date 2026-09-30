package worktree

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRemoveTempReadOnly(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tmp")
	cache := filepath.Join(dir, "home", "go", "pkg", "mod", "module")
	if err := os.MkdirAll(cache, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "cache"), []byte("只读"), 0400); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(cache, 0500); err != nil {
		t.Fatal(err)
	}
	if err := RemoveTemp(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("目录未删除", err)
	}
	if err := RemoveTemp(dir); err != nil {
		t.Fatal("重复删除", err)
	}
}

func TestRemoveTempDoesNotFollowLink(t *testing.T) {
	root := t.TempDir()
	out := filepath.Join(root, "outside")
	if err := os.WriteFile(out, []byte("保留"), 0400); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(out, 0600) })
	dir := filepath.Join(root, "tmp")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(out, filepath.Join(dir, "link")); err != nil {
		t.Skipf("系统不允许创建符号链接：%v", err)
	}
	before, _ := os.Stat(out)
	if err := RemoveTemp(dir); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(out)
	if err != nil || before.Mode() != after.Mode() {
		t.Fatalf("修改了外部文件：%v", err)
	}
}
