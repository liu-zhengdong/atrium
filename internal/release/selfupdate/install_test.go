package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
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
	for _, missing := range []string{asset, SumsFile} {
		if err := Install(context.Background(), &fakeGH{missing: []string{missing}}, "o/r", "v2.0.4", exe); err == nil ||
			!strings.Contains(err.Error(), "v2.0.4 的 Release 下载不到 "+missing) {
			t.Fatalf("缺文件应说清：%v", err)
		}
		assertFileContent(t, exe, "new binary v2.0.2")
	}
}

// 非空目录可移植地模拟 .old 被占用：Remove 和固定名 Rename 都应失败。
func TestInstallOccupiedBackup(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "atrium")
	if err := os.WriteFile(exe, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(exe+".old", 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(exe+".old", "occupied")
	if err := os.WriteFile(marker, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	stale := exe + ".old-123"
	if err := os.WriteFile(stale, []byte("stale"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Install(context.Background(), &fakeGH{}, "o/r", "v2.0.1", exe); err != nil {
		t.Fatal(err)
	}
	assertFileContent(t, exe, "new binary v2.0.1")
	assertFileContent(t, marker, "keep")
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("无锁遗留备份应已清掉：%v", err)
	}
	backups, err := filepath.Glob(exe + ".old-*")
	if err != nil || len(backups) != 1 {
		t.Fatalf("应只有一个唯一名备份：%v，%v", backups, err)
	}
	if _, err := strconv.ParseInt(strings.TrimPrefix(backups[0], exe+".old-"), 10, 64); err != nil {
		t.Fatalf("备份后缀应为时间戳：%s", backups[0])
	}
	assertFileContent(t, backups[0], "old")
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 3 {
		t.Fatalf("应只剩新版、占用目录和旧版备份：%v，%v", entries, err)
	}
	// 占用解除后下轮清掉两类遗留，再回到固定的手动退回位置。
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	if err := Install(context.Background(), &fakeGH{}, "o/r", "v2.0.2", exe); err != nil {
		t.Fatal(err)
	}
	assertFileContent(t, exe, "new binary v2.0.2")
	assertFileContent(t, exe+".old", "new binary v2.0.1")
	entries, err = os.ReadDir(dir)
	if err != nil || len(entries) != 2 {
		t.Fatalf("占用解除后应清掉遗留备份和临时目录：%v，%v", entries, err)
	}
}

func TestInstallMissingExecutable(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "atrium")
	// 源文件缺失时，固定名和唯一名都挪不动，不能把新版安装成功当作回执。
	err := Install(context.Background(), &fakeGH{}, "o/r", "v2.0.1", exe)
	var renameErr *os.LinkError
	if !errors.As(err, &renameErr) || renameErr.Old != exe || !strings.HasPrefix(renameErr.New, exe+".old-") {
		t.Fatalf("应返回唯一名改名失败：%v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("失败不应留下新文件、备份或临时下载：%v，%v", entries, err)
	}
}

func TestReplaceBinaryRestoresOld(t *testing.T) {
	for _, occupied := range []bool{false, true} {
		t.Run(fmt.Sprintf("occupied=%t", occupied), func(t *testing.T) {
			dir := t.TempDir()
			exe := filepath.Join(dir, "atrium")
			if err := os.WriteFile(exe, []byte("old"), 0o755); err != nil {
				t.Fatal(err)
			}
			if occupied {
				if err := os.Mkdir(exe+".old", 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(exe+".old", "occupied"), []byte("keep"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			// 故意不给新版文件，确定走到已备份但放置失败的分支。
			fresh := filepath.Join(dir, "missing")
			err := replaceBinary(fresh, exe)
			var renameErr *os.LinkError
			if !errors.As(err, &renameErr) || renameErr.Old != fresh || renameErr.New != exe ||
				!strings.Contains(err.Error(), fmt.Sprintf("新版本放不进 %s（旧版本在 %s）", exe, exe)) {
				t.Fatalf("应保留安装错误并报告旧版已回原位：%v", err)
			}
			assertFileContent(t, exe, "old")
			wantEntries := 1
			if occupied {
				assertFileContent(t, filepath.Join(exe+".old", "occupied"), "keep")
				wantEntries++
			}
			entries, err := os.ReadDir(dir)
			if err != nil || len(entries) != wantEntries {
				t.Fatalf("恢复后不应残留本次备份：%v，%v", entries, err)
			}
		})
	}
}

func assertFileContent(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil || string(got) != want {
		t.Fatalf("%s：内容 %q，想要 %q，错误 %v", path, got, want, err)
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
