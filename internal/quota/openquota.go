package quota

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/platform"
)

// run 经 platform 拉起一个短命令，限时读完标准输出。返回退出码（拉不起为 -1）。
func run(ctx context.Context, path string, args []string, env map[string]string, limit time.Duration) ([]byte, int, error) {
	var out, stderr bytes.Buffer
	cmd, err := platform.Start(platform.Spec{Path: path, Args: args, Env: env, Stdout: &out, Stderr: &stderr})
	if err != nil {
		return nil, -1, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-time.After(limit):
		cmd.Process.Kill()
		<-done
		return nil, -1, errors.New("超时")
	case <-ctx.Done():
		cmd.Process.Kill()
		<-done
		return nil, -1, ctx.Err()
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return out.Bytes(), exit.ExitCode(), nil
	}
	if err == nil && stderr.Len() > 0 && len(args) > 0 && args[0] == "pace" {
		// 现有 pace 混合坏行可能退出 0 却写警告；不把部分来源当整轮成功。
		// 固定错误句，不外传响应正文、路径或凭据。
		err = errors.New("命令输出诊断，来源结果未完整验证")
	}
	return out.Bytes(), 0, err
}

// keychain 读 macOS 钥匙串（/usr/bin/security，Claude Code 自己也这样写，读时不弹授权框）；别的平台没有钥匙串。
func keychain(goos string, env map[string]string) func(service, account string) (string, error) {
	return func(service, account string) (string, error) {
		if goos != "darwin" {
			return "", nil
		}
		args := []string{"find-generic-password", "-s", service}
		if account != "" {
			args = append(args, "-a", account)
		}
		args = append(args, "-w")
		out, code, err := run(context.Background(), "/usr/bin/security", args,
			map[string]string{"PATH": env["PATH"], "HOME": env["HOME"], "USER": env["USER"]}, 5*time.Second)
		switch {
		case err != nil:
			return "", errors.New("钥匙串读取失败")
		case code == 44: // 没有这一项
			return "", nil
		case code != 0:
			return "", errors.New("钥匙串读取失败")
		}
		return strings.TrimSpace(string(out)), nil
	}
}

// OpenquotaBin 是 OpenQuota 命令行的缺省位置；ATRIUM_OPENQUOTA_BIN 可覆盖，否则再按 PATH 找 openquota。
const OpenquotaBin = "/Applications/OpenQuota.app/Contents/MacOS/openquota"

// Pace 是 `openquota pace --json` 的一行（过渡期保留读取和存储）。
type Pace struct {
	SourceFacts
	Account       string   `json:"providerId"`
	Plan          *string  `json:"plan"`
	UsedPercent   *float64 `json:"usedPercent"`
	ElapsedPct    *float64 `json:"periodElapsedPercent"`
	SparePercent  *float64 `json:"sparePercent"`
	HoursToReset  *float64 `json:"hoursToReset"`
	ShortUsedPct  *float64 `json:"shortWindowUsedPercent"`
	RefreshedAt   string   `json:"refreshedAt"`
	RefreshedAgoH float64  `json:"refreshedHoursAgo"`
	Stale         bool     `json:"stale"`
}

// readOpenquota 跑 openquota pace --json。没装返回 nil, nil。
func readOpenquota(ctx context.Context, env map[string]string) ([]Pace, error) {
	bin := strings.TrimSpace(env["ATRIUM_OPENQUOTA_BIN"])
	if bin == "" {
		bin = OpenquotaBin
	}
	child := platform.WorkerEnv(goos(), env)
	delete(child, "ATRIUM_WORKER")
	path, err := platform.LookPath(bin, child)
	if err != nil {
		if path, err = platform.LookPath("openquota", child); err != nil {
			return nil, nil
		}
	}
	out, code, err := run(ctx, path, []string{"pace", "--json"}, child, 10*time.Second)
	if err != nil {
		return nil, errors.New("OpenQuota 读取" + err.Error())
	}
	if code != 0 {
		return nil, errors.New("OpenQuota 读取失败")
	}
	var rows []Pace
	if err := json.Unmarshal(out, &rows); err != nil {
		return nil, errors.New("OpenQuota 输出无法解析")
	}
	if err := validateSources(rows); err != nil {
		return nil, err
	}
	return rows, nil
}
