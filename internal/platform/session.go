package platform

import (
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// 会话指 Atrium 拉起的一次执行者或负责人进程连同它的子孙。每个会话有专属临时目录（WorkerEnv 设成 TMPDIR、TMP、TEMP），
// 由数据目录与任务（或负责人）算出，服务、代理重启后照样算得出。主体退出后，命令行或环境里引用这个目录的进程算会话残留：
// 子孙经环境继承它，另开进程组、会话也带着；环境读不到的（macOS 上系统自带程序、Chrome）多半把资料目录放在 TMPDIR 下，
// 参数里带着它。主动清空环境、又不在参数里引用它的进程不在覆盖范围内。

// WaitSession 等会话主体退出，再回收引用 dir 的残留进程。WaitDelay 防止残留进程握着输出管道阻塞 Wait。
func WaitSession(cmd *exec.Cmd, dir string) error {
	cmd.WaitDelay = time.Second
	err := cmd.Wait()
	return errors.Join(err, EndSession(cmd.Process.Pid, dir))
}

// sessionPIDs 从 `ps -o pid=,command=`（带环境）的输出里挑出命令行或环境引用 dir（本身或其下路径）的进程号。
func sessionPIDs(ps, dir string) []int {
	var pids []int
	for _, row := range strings.Split(ps, "\n") {
		pid, rest, ok := strings.Cut(strings.TrimSpace(row), " ")
		if !ok || !refers(rest, dir) {
			continue
		}
		if n, err := strconv.Atoi(pid); err == nil && n > 0 {
			pids = append(pids, n)
		}
	}
	return pids
}

// refers 判断 s 里是否出现完整路径 dir：前后都不接着路径名字符（后面可以接 /），t1/tmp 不算 t10/tmp、/x/t1/tmp。
func refers(s, dir string) bool {
	if dir == "" {
		return false
	}
	for i := 0; ; {
		j := strings.Index(s[i:], dir)
		if j < 0 {
			return false
		}
		at, end := i+j, i+j+len(dir)
		if (at == 0 || !pathByte(s[at-1])) && (end == len(s) || s[end] == '/' || !pathByte(s[end])) {
			return true
		}
		i = at + 1
	}
}

func pathByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("._-~/", c) >= 0 || c >= 0x80
}
