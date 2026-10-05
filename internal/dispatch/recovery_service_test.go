package dispatch

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/service"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 同一测试二进制兼作假 dsh：行为由 --patch 里的模型决定，不调用模型、不继承开发者的登录。
func recoveryDsh() int {
	patch := ""
	for i, arg := range os.Args {
		if arg == "--patch" && i+1 < len(os.Args) {
			patch = os.Args[i+1]
		}
	}
	mode := ""
	if b, err := os.ReadFile(patch); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(strings.TrimSpace(line), "model:"); ok {
				mode = strings.TrimSpace(v)
			}
		}
	}
	mode = mode[strings.LastIndex(mode, "/")+1:]
	io.Copy(io.Discard, os.Stdin)
	session := `{"type":"session","sessionId":"session-0123abcd-0123-0123-0123-0123456789ab"}`
	switch mode {
	case "quota":
		fmt.Println(session)
		fmt.Println("ERROR: You've hit your usage limit. Try again in ~5 min.")
		return 1
	case "silent", "silent-quota", "old-pr":
		// 零步骤静默退出：既没有正常收尾，也没有一次工具调用。
		fmt.Println(session)
		return 1
	case "error-busy":
		// 501 个旧文件让产出扫描触顶（按可能有产出处理），明确的 429 仍要判额度。
		old := time.Now().Add(-time.Hour)
		for i := range 501 {
			name := fmt.Sprintf("old-%03d.txt", i)
			if os.WriteFile(name, nil, 0600) != nil || os.Chtimes(name, old, old) != nil {
				return 2
			}
		}
		fmt.Println(session)
		fmt.Println(`{"type":"error","message":"429: Go usage limit exceeded"}`)
		return 1
	case "stopped", "fresh-pr":
		// 长活：留出停下任务或补 PR 事实的时间。
		fmt.Println(session)
		time.Sleep(time.Second)
	case "output":
		if err := os.WriteFile("delivery.txt", []byte("有效产出"), 0600); err != nil {
			return 2
		}
		fmt.Println(session)
	case "zero-action":
		fmt.Println(session)
		fmt.Println(`{"type":"status","phase":"step_end","turn":1,"usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}}`)
	case "missing":
		// 用量字段缺失：退出记录里读不到用量，但不影响这一轮正常收尾。
		fmt.Println(session)
		fmt.Println(`{"type":"status","phase":"step_end","turn":1}`)
	case "reclaim", "reclaim-wait":
		// 回收用例：写产出、核对子进程临时目录一致、重建自己的只读缓存；wait 模式留在长活里被回收。
		if err := os.WriteFile("continued.txt", []byte("继续干"), 0600); err != nil {
			return 2
		}
		temp := os.Getenv("TMPDIR")
		if temp == "" || os.Getenv("TMP") != temp || os.Getenv("TEMP") != temp {
			return 2
		}
		if err := os.Remove(filepath.Join(temp, "readonly")); err != nil && !os.IsNotExist(err) {
			return 2
		}
		if err := os.WriteFile(filepath.Join(temp, "readonly"), []byte("只读缓存"), 0o400); err != nil {
			return 2
		}
		if mode == "reclaim-wait" {
			time.Sleep(time.Minute)
		}
		fmt.Println(session)
	case "continue-pr":
		return continuePRWorker()
	default:
		fmt.Println(session)
	}
	fmt.Println(`{"type":"text","text":"交付结论：完成"}`)
	fmt.Println(`{"type":"final","text":"交付结论：完成"}`)
	return 0
}

// 实际隔离服务 HTTP task run → 账本 → 分派循环 → 假执行者进程 → 退出恢复。
// 不装配 hosts/quota 后台循环，不读取真实登录/额度，不启负责人。
func TestRecoveryServiceEntry(t *testing.T) {
	for _, mode := range []string{"quota", "unknown-other-host", "silent", "silent-quota", "error-busy", "old-pr", "fresh-pr", "zero-action", "missing", "output", "stopped", "no-candidate", "bounded", "known-pool", "different-account", "magpie-full"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("HOME", dir)
			t.Setenv("USERPROFILE", dir)
			t.Setenv("ATRIUM_DATA", dir)
			t.Setenv("ATRIUM_PORT", "")
			t.Setenv("ATRIUM_MAGPIE_URL", "")
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			bin := filepath.Join(dir, "bin")
			if err := os.Mkdir(bin, 0700); err != nil {
				t.Fatal(err)
			}
			fake := filepath.Join(bin, "dsh")
			if runtime.GOOS == "windows" {
				fake += ".exe"
			}
			in, err := os.Open(exe)
			if err != nil {
				t.Fatal(err)
			}
			out, err := os.OpenFile(fake, os.O_CREATE|os.O_WRONLY, 0700)
			if err != nil {
				in.Close()
				t.Fatal(err)
			}
			_, copyErr := io.Copy(out, in)
			in.Close()
			closeErr := out.Close()
			if copyErr != nil {
				t.Fatal(copyErr)
			}
			if closeErr != nil {
				t.Fatal(closeErr)
			}
			linkGit(t, bin)
			path := bin + string(os.PathListSeparator) + filepath.Dir(exe)
			if runtime.GOOS != "windows" {
				// EndSession 在 unix 上要调系统 ps 读会话环境，不能把系统工具目录挡在 PATH 外。
				path += string(os.PathListSeparator) + "/usr/bin" + string(os.PathListSeparator) + "/bin"
			}
			t.Setenv("PATH", path)
			db, err := store.Open(filepath.Join(dir, "atrium.db"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { db.Close() })
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			t.Cleanup(cancel)
			if err := os.WriteFile(filepath.Join(dir, "token"), []byte("recovery-test-token"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := hosts.EnsureLocal(ctx, db, hosts.Info{CLIs: map[string]hosts.CLI{"dsh": {Installed: true}}}); err != nil {
				t.Fatal(err)
			}
			// 唯一允许自动挑的内置工具是上面复制的假 dsh；其他工具未安装。
			oldIsolated := isolated
			isolated = func(*app.Env) bool { return false }
			t.Cleanup(func() { isolated = oldIsolated })
			save := func(name, src string) {
				t.Helper()
				if _, err := workers.SaveProfile(ctx, db, name, workers.Edit{Source: &src}, "u1"); err != nil {
					t.Fatal(err)
				}
			}
			// 假 dsh 的行为从 --patch 里的模型取；paid/free 靠单价分先后，free 更便宜。
			workerMode := mode
			if mode == "no-candidate" || mode == "bounded" || mode == "unknown-other-host" || mode == "known-pool" || mode == "different-account" {
				workerMode = "quota"
			}
			exit := "ok"
			if mode == "bounded" {
				exit = "quota"
			}
			for _, name := range []string{"paid", "free"} {
				charge := 10
				if name == "free" {
					charge = 0
				}
				yaml := fmt.Sprintf("model: fake/%s\nbilling: subscription\nprices: {currency: USD, input: %d, output: %d, cache_read: %d, cache_write: %d}\n", exit, charge, charge, charge, charge)
				// 身份未知时要能切到同一组合的另一台机器，不能被「换人」抢先。
				if mode == "no-candidate" || mode == "unknown-other-host" {
					yaml += "auto: false\n"
				}
				save("combos/dsh+"+name, "---\n"+yaml+"---\n")
			}
			mainYAML := "model: rev/" + workerMode + "\n"
			if mode == "no-candidate" || mode == "bounded" || mode == "silent" || mode == "silent-quota" || mode == "error-busy" || mode == "old-pr" || mode == "fresh-pr" {
				mainYAML += "auto: false\n"
			}
			save("combos/dsh+main", "---\n"+mainYAML+"---\n")
			if mode == "known-pool" || mode == "different-account" || mode == "magpie-full" {
				// dsh 不能声明自定义端点：档案写 endpoint 挂 magpie 会被 dsh 的 Check 拒（不支持自定义模型端点），
				// 所以这里的额度绑定一律由测试桩合成（见 installSyntheticExecution）。
				installSyntheticExecution(t, mode)
			}
			if mode == "known-pool" || mode == "different-account" {
				save("combos/dsh+sibling", "---\nmodel: rev/zero-action\n---\n")
				if mode == "different-account" {
					// 同工具的另一个已证实账号：本账号失败不连坐，它有读数就排在没读数的前面。
					if err := quota.Record(ctx, db, LocalHost, []quota.Reading{magpieReading("other", 10, 0)}); err != nil {
						t.Fatal(err)
					}
				}
			}
			remoteHost := ""
			if mode == "unknown-other-host" {
				h, code, err := hosts.Add(ctx, db, hosts.AddInput{Name: "另一机器（身份未知）", Repos: []string{"*"}}, 4999)
				if err != nil {
					t.Fatal(err)
				}
				if _, _, err := hosts.Join(ctx, db, code, hosts.Info{CLIs: map[string]hosts.CLI{"dsh": {Installed: true}}}); err != nil {
					t.Fatal(err)
				}
				remoteHost = h.ID
				for _, host := range []string{LocalHost, h.ID} {
					if err := quota.Record(ctx, db, host, []quota.Reading{{Account: quota.MagpieAccount, OK: true, Plan: "Go", Finger: host, ReadAt: store.Now(), Windows: []quota.Window{{ID: "month", Used: 0}}}}); err != nil {
						t.Fatal(err)
					}
				}
				oldLaunch, oldWait := launchRemote, waitRemote
				launchRemote = func(_ context.Context, _ *app.Env, host string, r Remote) (int, int, string, error) {
					if host != remoteHost {
						return 0, 0, "", fmt.Errorf("派错机器 %s", host)
					}
					log := `{"type":"session","sessionId":"session-0123abcd-0123-0123-0123-0123456789ab"}` + "\n" + `{"type":"text","text":"另一机器（身份未知）交付结论：完成"}` + "\n" + `{"type":"final","text":"另一机器（身份未知）交付结论：完成"}` + "\n"
					return 1, 4242, filepath.Join(dir, "remote-work"), os.WriteFile(r.Log, []byte(log), 0600)
				}
				waitRemote = func(context.Context, *app.Env, string, int) (hosts.Exit, error) {
					code := 0
					return hosts.Exit{Code: &code}, nil
				}
				t.Cleanup(func() { launchRemote, waitRemote = oldLaunch, oldWait })
			}
			done := make(chan error, 1)
			go func() { done <- service.Serve([]app.Module{ledger.Module(), Module()}, os.Getenv) }()
			c := &api.Client{Token: "recovery-test-token", HTTP: &http.Client{Timeout: 2 * time.Second}}
			t.Cleanup(func() {
				stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if c.Base != "" {
					if err := c.Do(stop, "POST", "/api/service/stop", nil, nil); err != nil {
						t.Error(err)
					}
				}
				select {
				case err := <-done:
					if err != nil {
						t.Error(err)
					}
				case <-stop.Done():
					t.Error("隔离服务未停止")
				}
			})
			wait := func(ok func() bool) {
				t.Helper()
				for !ok() {
					select {
					case <-ctx.Done():
						t.Fatal("隔离恢复等待超时")
					case <-time.After(20 * time.Millisecond):
					}
				}
			}
			wait(func() bool {
				info, err := config.ReadService(config.Paths{Data: dir})
				if err != nil {
					return false
				}
				c.Base = fmt.Sprintf("http://127.0.0.1:%d", info.Port)
				return true
			})
			call := func(method, path string, body, result any) {
				t.Helper()
				if err := c.Do(ctx, method, path, body, result); err != nil {
					t.Fatal(err)
				}
			}
			var tk ledger.Task
			call("POST", "/api/tasks", ledger.NewTask{Title: "隔离恢复 " + mode}, &tk)
			if mode == "old-pr" {
				pr := "https://test.invalid/pr/1"
				if err := ledger.SetFacts(ctx, db, tk.ID, ledger.Facts{PR: &pr}, "gates"); err != nil {
					t.Fatal(err)
				}
			}
			body := map[string]any{"worker": "dsh+main"}
			if mode == "magpie-full" {
				// dsh 不能声明自定义端点，档案写 endpoint 挂 magpie 会被 dsh 的 Check 拒（不支持自定义模型端点），
				// 所以额度绑定由测试桩合成。magpie 路径只报「窗口将满」，不给富余百分比，这里验的是这条阈值：
				// 窗口有余时主组合能接，将满时它被拒、挑人换到别的组合。
				preview := func(used float64) *PickView {
					t.Helper()
					if err := quota.Record(ctx, db, LocalHost, []quota.Reading{magpieReading("rev", used, store.Now()+3600_000)}); err != nil {
						t.Fatal(err)
					}
					var res RunResult
					call("POST", "/api/tasks/"+tk.ID+"/run", map[string]any{"dry_run": true}, &res)
					if res.Pick == nil {
						t.Fatal("dry-run 没有挑人结论")
					}
					return res.Pick
				}
				main := func(v *PickView) *Candidate {
					t.Helper()
					for i := range v.Candidates {
						if v.Candidates[i].ID == "dsh+main" {
							return &v.Candidates[i]
						}
					}
					t.Fatalf("候选里没有 dsh+main：%+v", v)
					return nil
				}
				if c := main(preview(40)); !c.Eligible {
					t.Fatalf("窗口有余时主组合应能接：%+v", c)
				}
				v := preview(92)
				c := main(v)
				// 将满现在是一条会恢复的标记：进 Waiting（挑人侧当「等恢复」候选），不是 Refusals。
				if !c.Eligible || !strings.Contains(c.Waiting, "额度将满") {
					t.Fatalf("窗口将满应把主组合留作等恢复候选：%+v", c)
				}
				if v.Recommended != "dsh+free" {
					t.Fatalf("窗口将满应换组合：recommended=%s（%s）", v.Recommended, v.Reason)
				}
				t.Logf("窗口将满：dsh+main 等待=%v；推荐=%s", c.Waiting, v.Recommended)
				delete(body, "worker")
			}
			call("POST", "/api/tasks/"+tk.ID+"/run", body, nil)
			if mode == "stopped" || mode == "silent-quota" || mode == "fresh-pr" {
				wait(func() bool { x, _ := ledger.Get(ctx, db, tk.ID); return x.Status == ledger.Running })
				if mode == "stopped" {
					call("PATCH", "/api/tasks/"+tk.ID, map[string]string{"status": "blocked", "note": "停下：隔离反向验证"}, nil)
				} else if mode == "fresh-pr" {
					pr := "https://test.invalid/pr/2"
					if err := ledger.SetFacts(ctx, db, tk.ID, ledger.Facts{PR: &pr}, "gates"); err != nil {
						t.Fatal(err)
					}
				} else {
					if err := quota.Record(ctx, db, LocalHost, []quota.Reading{{Account: quota.MagpieAccount, OK: true, Plan: "Go", Finger: "fake-account", ReadAt: store.Now(), Windows: []quota.Window{{ID: "month", Used: 100}}}}); err != nil {
						t.Fatal(err)
					}
				}
			}
			wantBlocked := mode == "stopped" || mode == "no-candidate" || mode == "bounded"
			wait(func() bool {
				x, _ := ledger.Get(ctx, db, tk.ID)
				if wantBlocked {
					return x.Status == ledger.Blocked
				}
				return x.Stage == ledger.StageGate
			})
			// 等实际退出记录，避免只看到了 task stop 的先行状态。
			wait(func() bool {
				h, _ := ledger.History(ctx, db, tk.ID, 20)
				for _, e := range h {
					if e.Kind == workers.ExitKind {
						return true
					}
				}
				return false
			})
			runs, err := workers.Runs(ctx, db, tk.ID, 10)
			if err != nil {
				t.Fatal(err)
			}
			marks, err := workers.Marks(ctx, db, store.Now())
			if err != nil {
				t.Fatal(err)
			}
			wantRuns := 1
			if mode == "quota" || mode == "silent" || mode == "silent-quota" || mode == "error-busy" || mode == "unknown-other-host" || mode == "old-pr" || mode == "known-pool" || mode == "different-account" {
				wantRuns = 2
			}
			if mode == "bounded" {
				wantRuns = 3
			}
			if len(runs) != wantRuns {
				t.Fatalf("拉起次数 %d want %d：%+v", len(runs), wantRuns, runs)
			}
			if wantRuns == 2 && mode != "unknown-other-host" && mode != "different-account" && (runs[1].Worker != "dsh+free" || runs[1].Why != workers.WhySwitch) {
				t.Fatalf("应实际选择已声明免费：%+v", runs)
			}
			if mode == "different-account" {
				// 不同已证实账号不连坐：只标失败的那个账号（main），换人不必等它；
				// 换到哪个组合由档案顺序定，这里不钉名字。
				if len(marks) != 1 || marks[0].Model != "main" || runs[1].Worker == "dsh+main" {
					t.Fatalf("不同已证实账号不连坐：runs=%+v marks=%+v", runs, marks)
				}
			}
			if mode == "known-pool" {
				if len(marks) != 2 {
					t.Fatalf("同池成员必须避免重试：%+v", marks)
				}
				if marks[0].Until != marks[1].Until {
					t.Fatal("共享失败不能延长保留期", marks)
				}
			}
			if mode == "magpie-full" && (runs[0].Worker != "dsh+free" || len(marks) != 0) {
				t.Fatalf("实际派活也应避开窗口将满的组合，且不记不可用：runs=%+v marks=%+v", runs, marks)
			}
			if mode == "unknown-other-host" && (runs[1].Worker != runs[0].Worker || runs[1].Host != remoteHost || runs[1].Why != workers.WhySwitch) {
				t.Fatalf("同组合应能切到另一机器（身份未知）：%+v", runs)
			}
			if (mode == "silent" || mode == "old-pr" || mode == "silent-quota") && (len(marks) != 1 || marks[0].Kind != workers.SignalNoStart) {
				t.Fatalf("空转不能冒充 quota：%+v", marks)
			}
			if mode == "quota" || mode == "error-busy" {
				if len(marks) != 1 || marks[0].Kind != workers.SignalQuota {
					t.Fatalf("报文有独立额度失败证据：%+v", marks)
				}
			}
			if mode == "zero-action" || mode == "missing" || mode == "output" || mode == "stopped" || mode == "fresh-pr" {
				if len(marks) != 0 {
					t.Fatalf("正常或被停不能标不可用：%+v", marks)
				}
			}
			if wantBlocked {
				for _, m := range marks {
					if m.Until == 0 {
						t.Fatalf("不能新增无限标记：%+v", marks)
					}
				}
			}
			got, _ := ledger.Get(ctx, db, tk.ID)
			t.Logf("HTTP task run → %s/%s，拉起=%d，worker=%s，marks=%d", got.Status, got.Stage, len(runs), got.Worker, len(marks))
		})
	}
}
