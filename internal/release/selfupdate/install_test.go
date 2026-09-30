package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// fakeGH 答 release download：往 -D 目录写本平台二进制（内容带版本）与 SHA256SUMS。
type fakeGH struct {
	badSum  bool     // SHA256SUMS 写错：Install 应拒绝
	missing []string // 下不到的文件
}

func (f *fakeGH) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	if name != "gh" || len(args) < 3 || args[0] != "release" || args[1] != "download" {
		return "", fmt.Errorf("fakeGH 不支持 %s %v", name, args)
	}
	out := args[len(args)-1]
	asset, bin := Asset(runtime.GOOS, runtime.GOARCH), []byte("new binary "+args[2])
	sum := sha256.Sum256(bin)
	if f.badSum {
		sum[0]++
	}
	if !slices.Contains(f.missing, SumsFile) {
		if err := os.WriteFile(filepath.Join(out, SumsFile), []byte(hex.EncodeToString(sum[:])+"  "+asset+"\n"), 0o644); err != nil {
			return "", err
		}
	}
	if !slices.Contains(f.missing, asset) {
		return "", os.WriteFile(filepath.Join(out, asset), bin, 0o644)
	}
	return "", nil
}

func TestInstall(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "atrium")
	os.WriteFile(exe, []byte("old"), 0o755)
	if err := Install(context.Background(), &fakeGH{}, "o/r", "v2.0.1", exe); err != nil {
		t.Fatal(err)
	}
	now, _ := os.ReadFile(exe)
	old, _ := os.ReadFile(exe + ".old")
	if string(now) != "new binary v2.0.1" || string(old) != "old" {
		t.Fatalf("新 %q 旧 %q", now, old)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 {
		t.Fatalf("临时目录没清掉：%v", entries)
	}
	// 再升一次：上一次的 .old 删掉，换成这次的旧版本。
	if err := Install(context.Background(), &fakeGH{}, "o/r", "v2.0.2", exe); err != nil {
		t.Fatal(err)
	}
	if old, _ := os.ReadFile(exe + ".old"); string(old) != "new binary v2.0.1" {
		t.Fatalf(".old 应是上一版：%q", old)
	}
	// 校验和不符：不替换。
	if err := Install(context.Background(), &fakeGH{badSum: true}, "o/r", "v2.0.3", exe); err == nil || !strings.Contains(err.Error(), "校验和不符") {
		t.Fatalf("校验和不符应拒绝：%v", err)
	}
	if now, _ := os.ReadFile(exe); string(now) != "new binary v2.0.2" {
		t.Fatalf("校验失败不该替换：%q", now)
	}
	// 二进制没下到：gh 只下到 SHA256SUMS 不报错，Install 要说清缺哪个文件。
	asset := Asset(runtime.GOOS, runtime.GOARCH)
	if err := Install(context.Background(), &fakeGH{missing: []string{asset}}, "o/r", "v2.0.4", exe); err == nil ||
		!strings.Contains(err.Error(), "v2.0.4 的 Release 下载不到 "+asset) {
		t.Fatalf("缺二进制应说清：%v", err)
	}
}

func TestCheckSum(t *testing.T) {
	sums := "aa  atrium-linux-amd64\nBB *atrium-darwin-arm64\n"
	for _, c := range []struct {
		asset, got string
		ok         bool
	}{
		{"atrium-linux-amd64", "aa", true},
		{"atrium-darwin-arm64", "bb", true},
		{"atrium-linux-amd64", "ab", false},
		{"atrium-windows-amd64.exe", "aa", false},
	} {
		if err := CheckSum(sums, c.asset, c.got); (err == nil) != c.ok {
			t.Errorf("%s %s：%v", c.asset, c.got, err)
		}
	}
}
