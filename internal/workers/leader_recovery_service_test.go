package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/org/leaders"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/service"
	"github.com/liu-zhengdong/atrium/internal/store"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe") == "pi" {
		os.Exit(fakeLeaderPi())
	}
	os.Exit(m.Run())
}

// 本次构建的测试二进制兼作假模型；实际负责人令牌只调用隔离服务。
func fakeLeaderPi() int {
	mode := ""
	for i, arg := range os.Args {
		if arg == "--model" && i+1 < len(os.Args) {
			_, mode, _ = strings.Cut(os.Args[i+1], "/")
		}
	}
	if mode == "quota" {
		fmt.Println("ERROR: usage limit reached")
		return 1
	}
	if mode == "stop" {
		if err := os.WriteFile(filepath.Join(os.Getenv("ATRIUM_DATA"), "started"), []byte("started"), 0600); err != nil {
			return 3
		}
		time.Sleep(time.Second)
	}
	fmt.Println(`{"type":"session","id":"fake-leader-session"}`)
	content := []any{}
	if mode == "good" || mode == "zero-action" || mode == "missing-ack" {
		info, err := config.ReadService(config.Paths{Data: os.Getenv("ATRIUM_DATA")})
		if err != nil {
			return 4
		}
		c := api.Client{Base: fmt.Sprintf("http://127.0.0.1:%d", info.Port), Token: os.Getenv("ATRIUM_LEADER_TOKEN"), HTTP: &http.Client{Timeout: time.Second}}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		var rows []events.Row
		if err := c.Do(ctx, "GET", "/api/events/wait?timeout=0", nil, &rows); err != nil {
			return 5
		}
		var ids []int64
		for _, row := range rows {
			ids = append(ids, row.ID)
		}
		if err := c.Do(ctx, "POST", "/api/events/ack", map[string]any{"ids": ids}, nil); err != nil {
			return 6
		}
		// 故意尝试确认别的负责人的事件；必须仍保持未确认。
		if err := c.Do(ctx, "POST", "/api/events/ack", map[string]any{"ids": []int64{2}}, nil); err == nil {
			return 7
		}
		content = append(content, map[string]string{"type": "text", "text": "已处理并确认本批事件"})
	}
	msg := map[string]any{"role": "assistant", "model": mode, "provider": "fake", "content": content}
	if mode != "missing" && mode != "missing-ack" {
		n := 0
		if mode == "good" {
			n = 17
		}
		msg["usage"] = map[string]int{"input": n, "output": 0, "cacheRead": 0, "cacheWrite": 0}
	}
	raw, _ := json.Marshal(map[string]any{"type": "message_end", "message": msg})
	fmt.Println(string(raw))
	fmt.Println(`{"type":"agent_settled"}`)
	return 0
}

func TestLeaderRecoveryServiceEntry(t *testing.T) {
	for _, mode := range []string{"quota", "silent", "cost", "known-pool", "different-account", "cached-exhausted", "zero-action", "missing-ack", "missing", "no-candidate", "bounded", "stopped"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("HOME", dir)
			t.Setenv("USERPROFILE", dir)
			t.Setenv("ATRIUM_DATA", dir)
			t.Setenv("ATRIUM_PORT", "")
			t.Setenv("ATRIUM_LEADER_WAKE", "1")
			if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("隔离原则"), 0600); err != nil {
				t.Fatal(err)
			}
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
			_, err = io.Copy(out, in)
			in.Close()
			cerr := out.Close()
			if err != nil {
				t.Fatal(err)
			}
			if cerr != nil {
				t.Fatal(cerr)
			}
			path := bin + string(os.PathListSeparator) + filepath.Dir(exe)
			if runtime.GOOS != "windows" {
				// EndSession 在 unix 上要调系统 ps 读会话环境，不能把系统工具目录挡在 PATH 外。
				path += string(os.PathListSeparator) + "/usr/bin" + string(os.PathListSeparator) + "/bin"
			}
			t.Setenv("PATH", path)
			paths := config.Paths{Data: dir}
			db, err := store.Open(paths.DB())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { db.Close() })
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if err := os.WriteFile(filepath.Join(dir, "token"), []byte("leader-test-token"), 0600); err != nil {
				t.Fatal(err)
			}
			save := func(name, src string) {
				t.Helper()
				if _, err := SaveProfile(ctx, db, name, Edit{Source: &src}, "test"); err != nil {
					t.Fatal(err)
				}
			}
			save("harness/pi", "---\ntrust: high\nmax_risk: high\nbilling: subscription\n---\n")
			first := mode
			switch mode {
			case "known-pool", "different-account", "cached-exhausted", "no-candidate", "bounded", "cost":
				first = "quota"
			case "stopped":
				first = "stop"
			}
			save("combos/pi+aaa", "---\nmodel: fake/"+first+"\n---\n")
			alternate := "good"
			if mode == "bounded" {
				alternate = "quota"
			}
			save("combos/pi+bbb", "---\nmodel: fake/"+alternate+"\n---\n")
			if mode == "no-candidate" {
				save("combos/pi+bbb", "---\nmodel: fake/good\nauto: false\n---\n")
			}
			if mode == "known-pool" || mode == "different-account" {
				save("combos/pi+ccc", "---\nmodel: fake/good\n---\n")
			}
			// 防止 Catalog 只写工具名时无意添加另一档；仍能通过显式组合解析。
			save("harness/pi", "---\ntrust: high\nmax_risk: high\nbilling: subscription\nauto: false\n---\n")
			save("combos/pi+aaa", "---\nmodel: fake/"+first+"\nauto: true\n---\n")
			if mode != "no-candidate" {
				save("combos/pi+bbb", "---\nmodel: fake/"+alternate+"\nauto: true\n---\n")
			}
			if mode == "known-pool" || mode == "different-account" {
				save("combos/pi+ccc", "---\nmodel: fake/good\nauto: true\n---\n")
			}
			if mode == "cost" {
				save("combos/pi+bbb", "---\nmodel: fake/good\nauto: true\nprices: {currency: USD, input: 2, output: 2, cache_read: 2, cache_write: 2}\n---\n")
				save("combos/pi+ccc", "---\nmodel: fake/good\nauto: true\nprices: {currency: USD, input: 0, output: 0, cache_read: 0, cache_write: 0}\n---\n")
			}
			oldResolve := ResolveExecution
			oldCheck := org.CheckWorker
			oldUsage := leaders.WakeUsage
			t.Cleanup(func() {
				ResolveExecution = oldResolve
				org.CheckWorker = oldCheck
				leaders.WakeUsage = oldUsage
				leaders.SetLauncher(nil)
			})
			if mode == "known-pool" || mode == "different-account" || mode == "cached-exhausted" {
				ResolveExecution = func(_ context.Context, _ *app.Env, r Resolved, host string) (Resolved, error) {
					if r.Spec.Tool != "pi" || (r.Spec.Model != "aaa" && r.Spec.Model != "bbb" && r.Spec.Model != "ccc") {
						return r, nil
					}
					account := "account-A"
					if r.Spec.Model == "bbb" && mode == "different-account" {
						account = "account-B"
					}
					if r.Spec.Model == "ccc" {
						account = "account-C"
					}
					r.QuotaBinding = &ExecutionBinding{Worker: r.ID, Host: host, Provider: "fake", Card: account, Source: "synthetic-resolver", Account: quota.AccountIdentity{Kind: "accountHash", Value: account, Source: "synthetic-account"}, Scope: &quota.SharedScope{ID: "pool", Source: "synthetic-pool", WindowIDs: []string{"month"}}, WindowIDs: []string{"month"}}
					return r, nil
				}
			}
			if mode == "cached-exhausted" {
				used := 100.0
				now := time.Now().UTC().Format(time.RFC3339Nano)
				row := quota.Pace{Account: "account-A", RefreshedAt: now, SourceFacts: quota.SourceFacts{Quotas: []quota.SourceWindow{{ID: "month", Format: "percent", UsedPercent: &used}}, ValueMetrics: []json.RawMessage{}, QuotaCount: 1, QuotaLimit: 64, ValueMetricLimit: 64, AccountIdentity: &quota.AccountIdentity{Kind: "accountHash", Value: "account-A", Source: "synthetic-account"}, SharedScope: &quota.SharedScope{ID: "pool", Source: "synthetic-pool", WindowIDs: []string{"month"}}, CacheIdentityMatch: "matched", DataQuality: "live", RefreshOutcome: "live"}}
				raw, _ := json.Marshal(map[string]any{"rows": []quota.Pace{row}})
				if _, err := db.ExecContext(ctx, `INSERT INTO quota_cache VALUES ('openquota','openquota',?,?)`, string(raw), store.Now()); err != nil {
					t.Fatal(err)
				}
				// 替代档使用另一账号，不能被 A 月耗尽连坐。
				prior := ResolveExecution
				ResolveExecution = func(ctx context.Context, e *app.Env, r Resolved, h string) (Resolved, error) {
					r, err := prior(ctx, e, r, h)
					if r.Spec.Model == "bbb" {
						r.QuotaBinding.Account.Value = "account-B"
						r.QuotaBinding.Card = "account-B"
					}
					return r, err
				}
			}
			who, err := org.AddLeader(ctx, db, org.NewLeader{Name: "隔离负责人", Workers: []string{"pi+aaa"}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := org.AddLeader(ctx, db, org.NewLeader{Name: "线外负责人", Workers: []string{"pi+aaa"}}); err != nil {
				t.Fatal(err)
			}
			if _, err := org.Add(ctx, db, org.NewDept{Name: "隔离部门", Leader: who.ID}); err != nil {
				t.Fatal(err)
			}
			for _, target := range []string{who.ID, "a2"} {
				if err := events.Emit(ctx, db, events.Event{Kind: events.TaskAssigned, Target: target, Level: events.Act, Dept: "o1", Body: map[string]string{"title": "隔离恢复"}}); err != nil {
					t.Fatal(err)
				}
			}
			// 只让 a1 到达原30秒批量唤醒条件；a2不会运行。
			if _, err := db.ExecContext(ctx, `UPDATE events SET at=? WHERE target=?`, store.Now()-31000, who.ID); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				done <- service.Serve([]app.Module{ledger.Module(), org.Module(), Module(), leaders.Module(), {Name: "events-routes", Routes: events.Routes}}, os.Getenv)
			}()
			client := api.Client{Token: "leader-test-token", HTTP: &http.Client{Timeout: time.Second}}
			t.Cleanup(func() {
				c, stop := context.WithTimeout(context.Background(), 5*time.Second)
				defer stop()
				if client.Base != "" {
					if err := client.Do(c, "POST", "/api/service/stop", nil, nil); err != nil {
						t.Error(err)
					}
				}
				select {
				case err := <-done:
					if err != nil {
						t.Error(err)
					}
				case <-c.Done():
					t.Error("隔离服务未停止")
				}
			})
			wait := func(ok func() bool) {
				t.Helper()
				for !ok() {
					select {
					case <-ctx.Done():
						t.Fatal("隔离负责人恢复等待超时")
					case <-time.After(20 * time.Millisecond):
					}
				}
			}
			wait(func() bool {
				info, err := config.ReadService(paths)
				if err != nil {
					return false
				}
				client.Base = fmt.Sprintf("http://127.0.0.1:%d", info.Port)
				return true
			})
			if mode == "stopped" {
				wait(func() bool { _, err := os.Stat(filepath.Join(dir, "started")); return err == nil })
				if err := (&pause.Store{DB: db}).Set(ctx, pause.All, "u1"); err != nil {
					t.Fatal(err)
				}
				time.Sleep(1500 * time.Millisecond)
			}
			var wakes []leaders.Wake
			if mode != "stopped" {
				wait(func() bool {
					wakes, err = leaders.ReadWakes(ctx, db, 0)
					if err != nil {
						t.Fatal(err)
					}
					if len(wakes) == 0 {
						return false
					}
					var target string
					if err := db.QueryRowContext(ctx, `SELECT target FROM events WHERE id=1`).Scan(&target); err != nil {
						t.Fatal(err)
					}
					return wakes[len(wakes)-1].Outcome == leaders.WakeOK || (target == org.Secretary && len(wakes) == 2)
				})
			}
			wakes, err = leaders.ReadWakes(ctx, db, 0)
			if err != nil {
				t.Fatal(err)
			}
			var target string
			var acked *int64
			if err := db.QueryRowContext(ctx, `SELECT target,acked_at FROM events WHERE id=1`).Scan(&target, &acked); err != nil {
				t.Fatal(err)
			}
			var foreign *int64
			if err := db.QueryRowContext(ctx, `SELECT acked_at FROM events WHERE id=2`).Scan(&foreign); err != nil {
				t.Fatal(err)
			}
			if foreign != nil {
				t.Fatal("越权确认线外事件")
			}
			marks, err := Marks(ctx, db, store.Now())
			if err != nil {
				t.Fatal(err)
			}
			saved, err := org.GetIdentity(ctx, db, who.ID)
			if err != nil || len(saved.Workers) != 1 || saved.Workers[0] != "pi+aaa" {
				t.Fatal("偏好被覆写", saved, err)
			}
			switch mode {
			case "stopped":
				if len(wakes) != 0 || acked != nil || target != who.ID || len(marks) != 0 {
					t.Fatal("被停后运行/记失败/确认", wakes, target, marks)
				}
			case "no-candidate", "bounded", "missing":
				if acked != nil || target != org.Secretary || len(wakes) != 2 {
					t.Fatal("未处理不能确认，须有界上报", wakes, target, acked)
				}
				if mode == "missing" && len(marks) != 0 {
					t.Fatal("缺usage误标不可用", marks)
				}
			default:
				expected := 2
				if mode == "zero-action" || mode == "missing-ack" || mode == "cached-exhausted" {
					expected = 1
				}
				if len(wakes) != expected || acked == nil || target != who.ID || wakes[len(wakes)-1].Outcome != leaders.WakeOK {
					t.Fatal("未恢复完成", wakes, target, acked)
				}
				want := "pi+bbb"
				if mode == "known-pool" || mode == "cost" {
					want = "pi+ccc"
				}
				if mode == "zero-action" || mode == "missing-ack" {
					want = "pi+aaa"
				}
				if wakes[len(wakes)-1].Profile != want {
					t.Fatalf("实际组合归属错误：%+v want %s", wakes, want)
				}
				if mode == "silent" && (len(marks) != 1 || marks[0].Kind != SignalNoStart) {
					t.Fatal("静默误标quota或未标", marks)
				}
				if mode == "known-pool" && (len(marks) != 2 || marks[0].Until != marks[1].Until) {
					t.Fatal("同池未共享原期限", marks)
				}
				if mode == "different-account" && len(marks) != 1 {
					t.Fatal("不同账号连坐", marks)
				}
				if (mode == "zero-action" || mode == "missing-ack") && len(marks) != 0 {
					t.Fatal("有效动作误标", marks)
				}
				if mode == "cost" || mode == "quota" || mode == "silent" || mode == "known-pool" || mode == "different-account" || mode == "cached-exhausted" {
					var u Usage
					if err := json.Unmarshal([]byte(wakes[len(wakes)-1].Usage), &u); err != nil || u.Input == nil || *u.Input != 17 {
						t.Fatal("实际组合用量错误", u, err)
					}
					qualities, err := ReadQuality(ctx, db)
					if err != nil {
						t.Fatal(err)
					}
					found := false
					for _, q := range qualities {
						if q.Leader && q.Combo == want && q.OK == 1 {
							found = true
						}
					}
					if !found {
						t.Fatal("负责人质量未归实际组合", qualities)
					}
				}
			}
			raw, _ := json.Marshal(map[string]any{"case": mode, "wakes": wakes, "marks": marks, "target": target, "acked": acked != nil, "foreignAcked": foreign != nil})
			t.Log(string(raw))
		})
	}
}
