//go:build windows

package platform

import (
	"fmt"
	"os"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	createNewProcessGroup   = 0x00000200
	createNoWindow          = 0x08000000
	processQueryLimitedInfo = 0x1000
	stillActive             = 259
	jobMsgActiveProcessZero = 4 // JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO
)

// 一律不弹窗；Detached 放进新进程组并先挂起，由 adopt 放进 Job 后再恢复。cmdLine 非空时原样作命令行（批处理）。
func sysProcAttr(detached bool, cmdLine string) *syscall.SysProcAttr {
	attr := &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow, CmdLine: cmdLine}
	if detached {
		attr.CreationFlags |= createNewProcessGroup | windows.CREATE_SUSPENDED
	}
	return attr
}

// Detached 进程的整棵树放进一个 Job：Git for Windows 的 sh 模拟 fork/exec，孙进程的父进程往往已退出，
// taskkill /T 顺着父子关系找不到它们；Job 里的进程拉起的子孙都留在 Job 里，TerminateJobObject 一个不漏。
// Job 句柄由拉起它的进程按 pid 记着，Job 里的进程全退出时经完成端口得知并关掉。
// 不是本进程拉起的（如服务重启前拉起的执行者）没有记录，KillTree 仍走 taskkill /T。
var jobs = struct {
	sync.Mutex
	once sync.Once
	port windows.Handle
	err  error
	byID map[int]windows.Handle
}{byID: map[int]windows.Handle{}}

// adopt 把挂起着拉起的 Detached 进程放进新 Job，再恢复它的主线程。
func adopt(pid int, managed bool) error {
	jobs.once.Do(func() {
		jobs.port, jobs.err = windows.CreateIoCompletionPort(windows.InvalidHandle, 0, 0, 1)
		if jobs.err == nil {
			go reapJobs(jobs.port)
		}
	})
	if jobs.err != nil {
		return fmt.Errorf("建完成端口：%w", jobs.err)
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return fmt.Errorf("建 Job：%w", err)
	}
	port := struct {
		Key  uintptr
		Port windows.Handle
	}{uintptr(job), jobs.port}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectAssociateCompletionPortInformation,
		uintptr(unsafe.Pointer(&port)), uint32(unsafe.Sizeof(port))); err != nil {
		windows.CloseHandle(job)
		return fmt.Errorf("Job 接完成端口：%w", err)
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_SUSPEND_RESUME|windows.PROCESS_DUP_HANDLE, false, uint32(pid))
	if err != nil {
		windows.CloseHandle(job)
		return fmt.Errorf("打开进程 %d：%w", pid, err)
	}
	defer windows.CloseHandle(h)
	if err := windows.AssignProcessToJobObject(job, h); err != nil {
		windows.CloseHandle(job)
		return fmt.Errorf("进程 %d 放进 Job：%w", pid, err)
	}
	if managed {
		limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
		limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
			windows.CloseHandle(job)
			return fmt.Errorf("Job 设置 kill-on-close：%w", err)
		}
		// 主体持有不继承的副本：服务/代理退出时任务继续；主体随后退出，最后一个句柄关闭，子孙被回收。
		// 当前服务仍在时由 EndSession 显式终止；完成端口随整棵树退出释放服务的句柄。
		var held windows.Handle
		if err := windows.DuplicateHandle(windows.CurrentProcess(), job, h, &held, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
			windows.CloseHandle(job)
			return fmt.Errorf("主体持有 Job：%w", err)
		}
	}
	// 进程还挂起着，Job 不会在记下之前变空。
	jobs.Lock()
	if old, ok := jobs.byID[pid]; ok { // pid 复用：旧 Job 不再跟踪
		windows.CloseHandle(old)
	}
	jobs.byID[pid] = job
	jobs.Unlock()
	return resume(h)
}

// reapJobs 收完成端口的通知：某个 Job 里的进程全退出了就关掉它的句柄、删掉记录。
func reapJobs(port windows.Handle) {
	for {
		var msg uint32
		var key uintptr
		var ov *windows.Overlapped
		if err := windows.GetQueuedCompletionStatus(port, &msg, &key, &ov, windows.INFINITE); err != nil || msg != jobMsgActiveProcessZero {
			continue
		}
		jobs.Lock()
		for pid, job := range jobs.byID {
			if uintptr(job) == key {
				windows.CloseHandle(job)
				delete(jobs.byID, pid)
			}
		}
		jobs.Unlock()
	}
}

var ntResumeProcess = windows.NewLazySystemDLL("ntdll.dll").NewProc("NtResumeProcess")

// resume 恢复刚拉起、还挂起着的进程。NtResumeProcess 一次调用；用 Toolhelp 线程快照找主线程要遍历全系统线程，一次上百毫秒。
func resume(h windows.Handle) error {
	if st, _, _ := ntResumeProcess.Call(uintptr(h)); st != 0 {
		return fmt.Errorf("恢复进程：NTSTATUS 0x%x", st)
	}
	return nil
}

// killJob 结束 pid 所在 Job 里的全部进程；本进程没记着它的 Job 返回 false，由调用方走 taskkill /T。
func killJob(pid int) (bool, error) {
	jobs.Lock()
	defer jobs.Unlock() // 持锁结束：reapJobs 不会在这期间关掉句柄
	job, ok := jobs.byID[pid]
	if !ok {
		return false, nil
	}
	return true, windows.TerminateJobObject(job, 1)
}

func killGroup(pid int) error { return nil } // Windows 走 killJob 或 KillTreeInvocation，不会到这里

func alive(pid int) bool {
	h, err := syscall.OpenProcess(processQueryLimitedInfo, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if err := syscall.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == stillActive
}

func isExecutable(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}
