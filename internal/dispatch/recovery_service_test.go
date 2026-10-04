package dispatch

import (
	"context"
	"encoding/json"
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

// 同一测试二进制兼作假 pi，不调用模型、不继承开发者的登录。
func recoveryPi() int {
	model := ""
	for i, arg := range os.Args {
		if arg == "--model" && i+1 < len(os.Args) {
			model = os.Args[i+1]
		}
	}
	mode := model[strings.LastIndex(model, "/")+1:]
	if mode == "quota" {
		return recoveryCLI("quota")
	}
	fmt.Println(`{"type":"session","id":"fake-session"}`)
	if mode == "stopped" || mode == "silent-quota" || mode == "fresh-pr" {
		time.Sleep(time.Second)
	}
	if mode == "output" {
		if err := os.WriteFile("delivery.txt", []byte("有效产出"), 0600); err != nil {
			return 2
		}
	}
	if mode == "error-busy" {
		// 501 个旧文件让产出扫描触顶（按可能有产出处理），明确的 429 仍要判额度。
		old := time.Now().Add(-time.Hour)
		for i := range 501 {
			name := fmt.Sprintf("old-%03d.txt", i)
			if os.WriteFile(name, nil, 0600) != nil || os.Chtimes(name, old, old) != nil {
				return 2
			}
		}
	}
	content := []any{}
	if mode == "zero-action" || mode == "missing" {
		content = append(content, map[string]string{"type": "text", "text": "交付完成"})
	}
	m := map[string]any{"role": "assistant", "model": mode, "provider": "opencode-go", "content": content}
	if mode == "error-busy" {
		m["stopReason"] = "error"
		m["errorMessage"] = `429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}`
	}
	if mode != "missing" {
		m["usage"] = map[string]int{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
	}
	raw, _ := json.Marshal(map[string]any{"type": "message_end", "message": m})
	fmt.Println(string(raw))
	fmt.Println(`{"type":"agent_settled"}`)
	return 0
}

func recoveryCLI(mode string) int {
	if mode == "quota" {
		fmt.Println("ERROR: usage limit reached")
		return 1
	}
	fmt.Println("DONE\n交付结论：完成")
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
			fake := filepath.Join(bin, "pi")
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
			t.Setenv("PATH", bin+string(os.PathListSeparator)+filepath.Dir(exe))
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
			if err := hosts.EnsureLocal(ctx, db, hosts.Info{CLIs: map[string]hosts.CLI{"pi": {Installed: true}, "aaa-paid": {Installed: true}, "zzz-free": {Installed: true}}}); err != nil {
				t.Fatal(err)
			}
			// 唯一允许自动挑的内置工具是上面复制的假 pi；其他工具未安装。
			oldIsolated := isolated
			isolated = func(*app.Env) bool { return false }
			t.Cleanup(func() { isolated = oldIsolated })
			save := func(name, src string) {
				t.Helper()
				if _, err := workers.SaveProfile(ctx, db, name, workers.Edit{Source: &src}, "u1"); err != nil {
					t.Fatal(err)
				}
			}
			// 真实池关系未知，不能用 provider 映射伪造同套餐验收。
			save("harness/pi", "---\nmodel: opencode-go/quota\n---\n")
			for _, name := range []string{"aaa-paid", "zzz-free"} {
				charge := 10
				if name == "zzz-free" {
					charge = 0
				}
				cliMode := "success"
				if mode == "bounded" {
					cliMode = "quota"
				}
				quoted, _ := json.Marshal(filepath.Base(exe))
				profile := fmt.Sprintf("---\nprotocol: cli\ncommand: %s\nargs: ['--recovery-fake-worker','%s','{prompt}']\ndone_match: '^DONE$'\nbilling: subscription\nprices: {currency: USD, input: %d, output: %d, cache_read: %d, cache_write: %d}\n", quoted, cliMode, charge, charge, charge, charge)
				if mode == "no-candidate" || mode == "unknown-other-host" {
					profile += "auto: false\n"
				}
				save("harness/"+name, profile+"---\n")
			}
			if mode == "no-candidate" || mode == "bounded" || mode == "silent" || mode == "silent-quota" || mode == "error-busy" || mode == "old-pr" || mode == "fresh-pr" {
				save("harness/pi", "---\nmodel: opencode-go/quota\nauto: false\n---\n")
			}
			if mode == "magpie-full" {
				// 走缺省 ResolveExecution：端点是 magpie 网关、模型是 <provider>/<模型> 才挂绑定（pi 不会真连它）。
				save("harness/pi", "---\nmodel: cursor/quota\nendpoint: "+quota.MagpieURL+"/v1\nendpoint_api: openai\n---\n")
			}
			remoteHost := ""
			if mode == "unknown-other-host" {
				h, code, err := hosts.Add(ctx, db, hosts.AddInput{Name: "另一机器（身份未知）", Repos: []string{"*"}}, 4999)
				if err != nil {
					t.Fatal(err)
				}
				if _, _, err := hosts.Join(ctx, db, code, hosts.Info{CLIs: map[string]hosts.CLI{"pi": {Installed: true}}}); err != nil {
					t.Fatal(err)
				}
				remoteHost = h.ID
				for _, host := range []string{LocalHost, h.ID} {
					if err := quota.Record(ctx, db, host, []quota.Reading{{Account: "opencode", OK: true, Plan: "Go", Finger: host, ReadAt: store.Now(), Windows: []quota.Window{{ID: "month", Used: 0}}}}); err != nil {
						t.Fatal(err)
					}
				}
				oldLaunch, oldWait := launchRemote, waitRemote
				launchRemote = func(_ context.Context, _ *app.Env, host string, r Remote) (int, int, string, error) {
					if host != remoteHost {
						return 0, 0, "", fmt.Errorf("派错机器 %s", host)
					}
					log := `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"另一机器（身份未知）交付完成"}]}}` + "\n" + `{"type":"agent_settled"}` + "\n"
					return 1, 4242, filepath.Join(dir, "remote-work"), os.WriteFile(r.Log, []byte(log), 0600)
				}
				waitRemote = func(context.Context, *app.Env, string, int) (hosts.Exit, error) {
					code := 0
					return hosts.Exit{Code: &code}, nil
				}
				t.Cleanup(func() { launchRemote, waitRemote = oldLaunch, oldWait })
			}
			if mode == "known-pool" || mode == "different-account" {
				installSyntheticExecution(t, mode)
				save("combos/pi+sibling", "---\nmodel: opencode-go/zero-action\n---\n")
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
			workerMode := mode
			if mode == "no-candidate" || mode == "bounded" || mode == "unknown-other-host" || mode == "known-pool" || mode == "different-account" {
				workerMode = "quota"
			}
			body := map[string]any{"worker": "pi+opencode-go/" + workerMode}
			if mode == "magpie-full" {
				// 同一入口先看窗口有余（假读数 40%）时推荐经 magpie 的 pi，再造窗口将满（92%）看它被避开。
				preview := func(used float64) *PickView {
					t.Helper()
					if err := quota.Record(ctx, db, LocalHost, []quota.Reading{magpieReading("cursor", used, store.Now()+3600_000)}); err != nil {
						t.Fatal(err)
					}
					var res RunResult
					call("POST", "/api/tasks/"+tk.ID+"/run", map[string]any{"dry_run": true}, &res)
					if res.Pick == nil {
						t.Fatal("dry-run 没有挑人结论")
					}
					return res.Pick
				}
				if v := preview(40); v.Recommended != "pi+cursor/quota" {
					t.Fatalf("窗口有余时应推荐经 magpie 的 pi：%+v", v)
				}
				v := preview(92)
				waiting := ""
				for _, c := range v.Candidates {
					if c.ID == "pi+cursor/quota" {
						waiting = c.Waiting
					}
				}
				if v.Recommended != "zzz-free" || !strings.Contains(waiting, "额度将满") {
					t.Fatalf("窗口将满应换组合：recommended=%s waiting=%q", v.Recommended, waiting)
				}
				t.Logf("窗口将满：pi+cursor/quota 等=%s；推荐=%s", waiting, v.Recommended)
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
					if err := quota.Record(ctx, db, LocalHost, []quota.Reading{{Account: "opencode", OK: true, Plan: "Go", Finger: "fake-account", ReadAt: store.Now(), Windows: []quota.Window{{ID: "month", Used: 100}}}}); err != nil {
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
			if wantRuns == 2 && mode != "unknown-other-host" && mode != "different-account" && (runs[1].Worker != "zzz-free" || runs[1].Why != workers.WhySwitch) {
				t.Fatalf("应实际选择已声明免费：%+v", runs)
			}
			if mode == "different-account" && (runs[1].Worker != "pi+sibling" || len(marks) != 1) {
				t.Fatalf("不同已证实账号不连坐：runs=%+v marks=%+v", runs, marks)
			}
			if mode == "known-pool" {
				if len(marks) != 2 {
					t.Fatalf("同池成员必须避免重试：%+v", marks)
				}
				if marks[0].Until != marks[1].Until {
					t.Fatal("共享失败不能延长保留期", marks)
				}
			}
			if mode == "magpie-full" && (runs[0].Worker != "zzz-free" || len(marks) != 0) {
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
