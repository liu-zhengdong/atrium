package platform

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os/exec"
	"sync"
	"time"
)

const sessionKey = "ATRIUM_PROCESS_SESSION"

var sessions sync.Map // pid -> 每次拉起独立的标记，WaitSession 后删除

func sessionEnv(base map[string]string) (map[string]string, error) {
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	env := make(map[string]string, len(base)+1)
	for k, v := range base {
		env[k] = v
	}
	env[sessionKey] = hex.EncodeToString(nonce[:])
	return env, nil
}
func rememberSession(pid int, token string) { sessions.Store(pid, token) }

// WaitSession 等会话主体退出，再回收残留子进程。WaitDelay 防止残留进程握着输出管道阻塞 Wait。
func WaitSession(cmd *exec.Cmd) error {
	cmd.WaitDelay = time.Second
	err := cmd.Wait()
	cleanup := killSession(cmd.Process.Pid)
	sessions.Delete(cmd.Process.Pid)
	return errors.Join(err, cleanup)
}
