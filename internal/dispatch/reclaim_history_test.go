package dispatch

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/service"
)

// 启真实 HTTP 服务与 dispatch 模块，重现三种历史格式和缺 exit 的 launch。
// 坏登记放在正常登记之前，验证不能因第一件坏数据就停止服务或阻断后续回收。
func TestReclaimHistoricalServiceStartup(t *testing.T) {
	d, gh, ctx := reclaimRig(t)
	bad, err := ledger.Add(ctx, d.env.DB, ledger.NewTask{Title: "空目录历史登记"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if err := ledger.Record(ctx, d.env.DB, bad.ID, gates.KindWorktree, actor, `{"dir":""}`); err != nil {
		t.Fatal(err)
	}
	applyReclaim(t, d, ctx, bad.ID, ledger.Event{Kind: ledger.Cancel})
	broken, err := ledger.Add(ctx, d.env.DB, ledger.NewTask{Title: "坏 JSON"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if err := ledger.Record(ctx, d.env.DB, broken.ID, gates.KindWorktree, actor, `{`); err != nil {
		t.Fatal(err)
	}
	applyReclaim(t, d, ctx, broken.ID, ledger.Event{Kind: ledger.Cancel})
	var dirs []string
	for _, host := range []string{LocalHost, ""} {
		tk, dir := reclaimTask(t, d, gh, ctx)
		body, _ := json.Marshal(gates.Worktree{Host: host, Dir: dir})
		// 缺 host 的历史格式没有该键；launch 同样没有 host，也没有对应 exit。
		if host == "" {
			body, _ = json.Marshal(map[string]string{"dir": dir})
			if err := ledger.Record(ctx, d.env.DB, tk.ID, "launch", actor, `{"n":1,"pid":-1}`); err != nil {
				t.Fatal(err)
			}
		}
		if err := ledger.Record(ctx, d.env.DB, tk.ID, gates.KindWorktree, actor, string(body)); err != nil {
			t.Fatal(err)
		}
		applyReclaim(t, d, ctx, tk.ID, ledger.Event{Kind: ledger.Set, To: ledger.Done})
		dirs = append(dirs, dir)
	}
	t.Setenv("ATRIUM_DATA", d.env.Paths.Data)
	t.Setenv("ATRIUM_PORT", "")
	client := &http.Client{Timeout: time.Second}
	for round := 1; round <= 2; round++ {
		done := make(chan error, 1)
		go func() { done <- service.Serve([]app.Module{Module()}, os.Getenv) }()
		var base string
		stopped := false
		stop := func() {
			if stopped {
				return
			}
			stopped = true
			if base != "" {
				req, _ := http.NewRequest("POST", base+"/api/service/stop", nil)
				req.Header.Set("Authorization", "Bearer isolated-test-token")
				if resp, err := client.Do(req); err == nil {
					resp.Body.Close()
				}
			}
			select {
			case err := <-done:
				if err != nil {
					t.Errorf("隔离服务：%v", err)
				}
			case <-time.After(5 * time.Second):
				t.Error("隔离服务未停止")
			}
		}
		t.Cleanup(stop)
		waitReclaim(t, ctx, func() bool {
			info, err := config.ReadService(d.env.Paths)
			if err != nil {
				return false
			}
			base = fmt.Sprintf("http://127.0.0.1:%d", info.Port)
			for _, dir := range dirs {
				if _, err := os.Stat(dir); !os.IsNotExist(err) {
					return false
				}
			}
			var count int
			if err := d.env.DB.QueryRowContext(ctx, `SELECT count(*) FROM task_events WHERE kind = ? AND actor = 'dispatch.reclaim'`, ledger.KindLoopError).Scan(&count); err != nil {
				return false
			}
			return count == 2
		})
		resp, err := client.Get(base + "/health")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("服务不健康：%d", resp.StatusCode)
		}
		for _, id := range []string{bad.ID, broken.ID} {
			why, found, err := gates.Last(ctx, d.env.DB, id, ledger.KindLoopError)
			if err != nil || !found || !strings.Contains(why, "工作树登记") {
				t.Fatalf("跳过原因缺失：%s %v", why, err)
			}
			if _, found, err := gates.Last(ctx, d.env.DB, id, reclaimedKind); err != nil || found {
				t.Fatalf("坏登记被标成回收成功：%v", err)
			}
		}
		stop()
		t.Logf("第 %d 次隔离启动：有 host、无 host 且无 exit 的工作树已回收；空目录/坏 JSON 各记一次错误；health=200", round)
	}
}

func TestReclaimSkippedPageAdvances(t *testing.T) {
	d, gh, ctx := reclaimRig(t)
	bad, err := ledger.Add(ctx, d.env.DB, ledger.NewTask{Title: "一页坏登记"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		if err := ledger.Record(ctx, d.env.DB, bad.ID, gates.KindWorktree, actor, `{"dir":""}`); err != nil {
			t.Fatal(err)
		}
	}
	applyReclaim(t, d, ctx, bad.ID, ledger.Event{Kind: ledger.Cancel})
	good, dir := reclaimTask(t, d, gh, ctx)
	applyReclaim(t, d, ctx, good.ID, ledger.Event{Kind: ledger.Cancel})
	for i := 0; i < 3; i++ {
		if err := d.reclaim(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Clean(dir)); !os.IsNotExist(err) {
		t.Fatalf("坏登记页挡住后一页：%v", err)
	}
	var count int
	if err := d.env.DB.QueryRowContext(ctx, `SELECT count(*) FROM task_events WHERE task = ? AND kind = ?`, bad.ID, ledger.KindLoopError).Scan(&count); err != nil || count != 1 {
		t.Fatalf("错误重复记录：%d %v", count, err)
	}
}
