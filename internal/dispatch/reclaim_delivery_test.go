package dispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/service"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 实际隔离服务、HTTP 入口、SQLite、假执行者子进程、交付检查与生命周期回收。
// 交付检查由测试推进，固定交付检查打回在 stage=gate 时发生的顺序。
func TestReclaimInPlaceDeliveryAndRequeue(t *testing.T) {
	d, gh, ctx := reclaimRig(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Dir(exe)+string(os.PathListSeparator)+os.Getenv("PATH"))
	quoted, _ := json.Marshal(filepath.Base(exe))
	source := "---\nprotocol: cli\ncommand: " + string(quoted) + "\nargs: [\"--reclaim-fake-worker\", \"{prompt}\"]\ndone_match: '^DONE$'\n---\n"
	if _, err := workers.SaveProfile(ctx, d.env.DB, "harness/reclaimfake", workers.Edit{Source: &source}, "u1"); err != nil {
		t.Fatal(err)
	}
	oldPick, oldSpares := pickHost, spares
	pickHost = func(context.Context, *app.Env, HostNeed, string) (HostChoice, error) {
		return HostChoice{Kind: "run", Host: LocalHost}, nil
	}
	spares = func(context.Context, *app.Env) (map[string]Spare, error) { return map[string]Spare{}, nil }
	t.Cleanup(func() { pickHost, spares = oldPick, oldSpares })
	t.Setenv("ATRIUM_DATA", d.env.Paths.Data)
	t.Setenv("ATRIUM_PORT", "")
	gateModule := gates.Module()
	gateModule.Run = nil
	done := make(chan error, 1)
	go func() { done <- service.Serve([]app.Module{ledger.Module(), Module(), gateModule}, os.Getenv) }()
	c := &api.Client{Token: "isolated-test-token", HTTP: &http.Client{Timeout: 2 * time.Second}}
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if c.Base != "" {
			if err := c.Do(stopCtx, "POST", "/api/service/stop", nil, nil); err != nil {
				t.Errorf("停隔离服务：%v", err)
			}
		}
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("隔离服务：%v", err)
			}
		case <-stopCtx.Done():
			t.Error("隔离服务未停止")
		}
	})
	waitReclaim(t, ctx, func() bool {
		info, err := config.ReadService(d.env.Paths)
		if err != nil {
			return false
		}
		c.Base = fmt.Sprintf("http://127.0.0.1:%d", info.Port)
		resp, err := c.HTTP.Get(c.Base + "/health")
		if err != nil {
			return false
		}
		resp.Body.Close()
		return resp.StatusCode == http.StatusOK
	})
	place := t.TempDir()
	gh.Write(place, "user.txt", "用户原地数据")
	before, err := os.Stat(place)
	if err != nil {
		t.Fatal(err)
	}
	var tk ledger.Task
	call := func(method, path string, body, out any) {
		t.Helper()
		if err := c.Do(ctx, method, path, body, out); err != nil {
			t.Fatal(err)
		}
	}
	call("POST", "/api/tasks", ledger.NewTask{Title: "原地正常完成与打回", Dir: place}, &tk)
	defer func() {
		if t.Failed() {
			history, _ := ledger.History(ctx, d.env.DB, tk.ID, 15)
			t.Logf("隔离调用链失败现场：%+v", history)
		}
	}()
	path := "/api/tasks/" + tk.ID
	gate := &gates.Gate{DB: d.env.DB, Data: d.env.Paths.Data, Pause: d.env.Pause, R: gh, Log: d.env.Log}
	for round := 1; round <= 2; round++ {
		if round == 2 {
			call("PATCH", path, map[string]string{"status": "todo"}, nil)
		}
		call("POST", path+"/run", map[string]string{"worker": "reclaimfake"}, nil)
		atGate := func() bool {
			x, err := ledger.Get(ctx, d.env.DB, tk.ID)
			return err == nil && x.Status == ledger.Running && x.Stage == ledger.StageGate
		}
		waitReclaim(t, ctx, atGate)
		if round == 2 {
			if _, err := gates.Bounce(ctx, d.env.DB, tk.ID, gates.Actor, "验证交付检查打回重排"); err != nil {
				t.Fatal(err)
			}
			waitReclaim(t, ctx, atGate)
		}
		if err := gate.Sweep(ctx); err != nil {
			t.Fatal(err)
		}
		waitReclaim(t, ctx, func() bool {
			var runs, reclaimed int
			if err := d.env.DB.QueryRowContext(ctx, `SELECT count(*) FROM task_events WHERE task=? AND kind='worktree'`, tk.ID).Scan(&runs); err != nil {
				return false
			}
			if err := d.env.DB.QueryRowContext(ctx, `SELECT count(*) FROM task_events WHERE task=? AND kind=?`, tk.ID, reclaimedKind).Scan(&reclaimed); err != nil {
				return false
			}
			return runs > 0 && reclaimed == runs
		})
		got, err := ledger.Get(ctx, d.env.DB, tk.ID)
		if err != nil || got.Status != ledger.Done {
			t.Fatalf("原地完成状态：%+v %v", got, err)
		}
		if _, found, err := gates.Last(ctx, d.env.DB, tk.ID, ledger.KindLoopError); err != nil || found {
			t.Fatalf("原地回收误报：%v", err)
		}
	}
	runs, err := workers.Runs(ctx, d.env.DB, tk.ID, 10)
	if err != nil || len(runs) != 3 {
		t.Fatalf("正常、重开、打回的实际拉起：%+v %v", runs, err)
	}
	for i, r := range runs {
		if r.N != i+1 || r.Dir != place {
			t.Fatalf("新旧轮次或原地目录不一致：%+v", r)
		}
	}
	after, err := os.Stat(place)
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("原地目录发生替换：%v", err)
	}
	if b, err := os.ReadFile(filepath.Join(place, "user.txt")); err != nil || string(b) != "用户原地数据" {
		t.Fatalf("用户数据被改：%s %v", b, err)
	}
	if _, err := os.Stat(TempDir(d.env.Paths.Data, tk.ID)); !os.IsNotExist(err) {
		t.Fatalf("临时文件未回收：%v", err)
	}
	t.Log("只在隔离环境：health=200；HTTP add/run → 假执行者 → gate → done/reclaim；HTTP 重开与 gates.Bounce 共拉起 3 轮，目录/用户文件不变，无 loop_error")
}
