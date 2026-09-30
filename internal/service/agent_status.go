package service

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/platform"
)

// agentStatus 只查当前目录的接入登记与进程，不读取机器令牌，不搜索其他目录。
func agentStatus(c *cli.Ctx, p config.Paths) (bool, error) {
	if _, err := os.Stat(filepath.Join(p.Data, "agent.json")); err == nil {
		raw, err := os.ReadFile(filepath.Join(p.Data, "agent.pid"))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return true, err
		}
		pid := 0
		if err == nil {
			pid, err = strconv.Atoi(strings.TrimSpace(string(raw)))
			if err != nil || pid <= 0 {
				return true, fmt.Errorf("agent.pid 不是有效的进程号")
			}
		}
		alive := pid > 0 && platform.Alive(pid)
		state := "没在运行"
		if alive {
			state = fmt.Sprintf("在运行：pid %d", pid)
		}
		return true, c.Done(map[string]any{"running": alive, "agent": map[string]any{"pid": pid, "data": p.Data}}, "代理"+state+"\n数据目录："+p.Data, "atrium agent install --status")
	} else if !errors.Is(err, os.ErrNotExist) {
		return true, err
	}

	return false, nil
}
