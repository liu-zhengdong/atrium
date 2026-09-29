package platform

import (
	"os"
	"runtime"
	"testing"
	"time"
)

// 进程退出后 Job 句柄经完成端口关掉，不留在记录里。
func TestJobReleasedAfterExit(t *testing.T) {
	spec := Shell("exit 0")
	spec.Env, spec.Detached = WorkerEnv(runtime.GOOS, EnvMap(os.Environ())), true
	cmd, err := Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	cmd.Wait()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		jobs.Lock()
		_, held := jobs.byID[pid]
		jobs.Unlock()
		if !held {
			return
		}
	}
	t.Fatal("进程退出后 Job 句柄还记着")
}
