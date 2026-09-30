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
	"strings"
)

// Runner 跑一条外部命令（gh），返回标准输出。服务用 gates.Exec，远程代理用自己的执行者环境。
type Runner interface {
	Run(ctx context.Context, dir, name string, args ...string) (string, error)
}

// SumsFile 是发版工作流随二进制发布的校验和文件（sha256sum 格式）。
const SumsFile = "SHA256SUMS"

// CheckSum 在 sha256sum 格式的 sums 里找 asset 那一行，与实际算出的 got 比对（纯函数）。
func CheckSum(sums, asset, got string) error {
	for _, line := range strings.Split(sums, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == asset {
			if !strings.EqualFold(f[0], got) {
				return fmt.Errorf("%s 校验和不符（%s 写 %s，下载的是 %s），没装", asset, SumsFile, f[0], got)
			}
			return nil
		}
	}
	return fmt.Errorf("%s 里没有 %s 这一行，没装", SumsFile, asset)
}

// Install 从 GitHub Release 下载本平台二进制与 SHA256SUMS，校验和对上才替换 exe：旧文件留作 exe.old（手动退回用）。
// 下载放在 exe 同目录，改名不跨文件系统。
func Install(ctx context.Context, r Runner, repo, tag, exe string) error {
	dir, err := os.MkdirTemp(filepath.Dir(exe), ".atrium-update-")
	if err != nil {
		return fmt.Errorf("在 %s 建临时目录失败（没有写权限？）：%w", filepath.Dir(exe), err)
	}
	defer os.RemoveAll(dir)
	asset := Asset(runtime.GOOS, runtime.GOARCH)
	if _, err := r.Run(ctx, "", "gh", "release", "download", tag, "-R", repo, "-p", asset, "-p", SumsFile, "-D", dir); err != nil {
		return err
	}
	// 多个 -p 只要有一个匹配 gh 就不报错：缺的文件在这里说清楚。
	for _, f := range []string{asset, SumsFile} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			return fmt.Errorf("%s 的 Release 下载不到 %s（还没传完，或没发这个平台），没装", tag, f)
		}
	}
	fresh := filepath.Join(dir, asset)
	sums, err := os.ReadFile(filepath.Join(dir, SumsFile))
	if err != nil {
		return err
	}
	bin, err := os.ReadFile(fresh)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(bin)
	if err := CheckSum(string(sums), asset, hex.EncodeToString(sum[:])); err != nil {
		return fmt.Errorf("%s：%w", tag, err)
	}
	if err := os.Chmod(fresh, 0o755); err != nil {
		return err
	}
	old := exe + ".old"
	if err := os.Remove(old); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// 在跑的可执行文件不能覆盖写（Windows 上也不能删），但能改名：先把自己挪成 .old 再放新的。
	// 下次再升时旧进程早已退出，.old 删得掉。
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(fresh, exe); err != nil {
		return fmt.Errorf("新版本放不进 %s（旧版本在 %s）：%w", exe, old, err)
	}
	return nil
}
