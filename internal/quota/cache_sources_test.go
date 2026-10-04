package quota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestCacheMachineSources(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := store.Now()
	good := Reading{Account: "opencode", OK: true, Finger: "key-A", ReadAt: now, Windows: []Window{{ID: "month", Used: 100}, {ID: "week", Used: 25}}}
	for _, h := range []string{"h1", "h2"} {
		if err := Record(ctx, db, h, []Reading{good}); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := Cached(ctx, db)
	if err != nil || len(rows) != 2 {
		t.Fatal("同key多机不能覆盖", rows, err)
	}
	// 不同key不证明独立套餐；失败保留旧成功身份与原时间，不能归当前账号。
	failure := Reading{Account: "opencode", Finger: "key-B", ReadAt: now + 1, Reason: "登录已过期"}
	if err := Record(ctx, db, "h1", []Reading{failure}); err != nil {
		t.Fatal(err)
	}
	rows, err = Cached(ctx, db)
	if err != nil || len(rows) != 3 {
		t.Fatal(rows, err)
	}
	for _, r := range rows {
		if r.Host == "h1" && r.OK && (r.Finger != "key-A" || r.ReadAt != now || len(r.Windows) != 2 || r.Windows[0].Used != 100 || r.Windows[1].Used != 25) {
			t.Fatal("失败续鲜/覆盖全窗口", r)
		}
	}
	good.Finger = "key-B"
	good.ReadAt = now + 2
	if err := Record(ctx, db, "h1", []Reading{good}); err != nil {
		t.Fatal(err)
	}
	rows, _ = Cached(ctx, db)
	if len(rows) != 2 {
		t.Fatal("正常刷新应替换本机并清失败，不能删另一机", rows)
	}
	if err := DropHost(ctx, db, "h1"); err != nil {
		t.Fatal(err)
	}
	rows, _ = Cached(ctx, db)
	if len(rows) != 1 || rows[0].Host != "h2" {
		t.Fatal("机器生命周期清理", rows)
	}
	t.Log("预期同key保留2机、失败保留原时刻和全窗口、正常刷新替换本机、删除只清本机；实际符合")
}

func TestCacheLegacyAndLimit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	r := Reading{Account: "codex", OK: true, Finger: "old", ReadAt: store.Now()}
	body, _ := json.Marshal(Stored{Host: "h2", Reading: r})
	if _, err := db.ExecContext(ctx, `INSERT INTO quota_cache VALUES (?,?,?,?)`, "old", "codex", string(body), r.ReadAt); err != nil {
		t.Fatal(err)
	}
	rows, _ := Cached(ctx, db)
	if len(rows) != 1 || rows[0].Host != "h2" {
		t.Fatal("不能复原已丢的h1关联", rows)
	}
	if err := Record(ctx, db, "h2", []Reading{r}); err != nil {
		t.Fatal(err)
	}
	var old int
	db.QueryRow(`SELECT count(*) FROM quota_cache WHERE account='old'`).Scan(&old)
	if old != 0 {
		t.Fatal("旧行只在正常刷新清理")
	}
	for i := 1; i < CacheRows; i++ {
		if _, err := db.ExecContext(ctx, `INSERT INTO quota_cache VALUES (?,?,?,?)`, fmt.Sprintf("synthetic-%d", i), "codex", string(body), r.ReadAt); err != nil {
			t.Fatal(err)
		}
	}
	if rows, err := Cached(ctx, db); err != nil || len(rows) != CacheRows {
		t.Fatal("边界500必须完整", len(rows), err)
	}
	if err := Record(ctx, db, "h3", []Reading{r}); err == nil {
		t.Fatal("超限写入不能成功")
	}
	db.ExecContext(ctx, `INSERT INTO quota_cache VALUES ('overflow','codex',?,?)`, string(body), r.ReadAt)
	if rows, err := Cached(ctx, db); err == nil || rows != nil {
		t.Fatal("超限读取不能返回静默截断", len(rows), err)
	}
	t.Log("预期500完整、501写入拒绝并回滚、旧库501读取拒绝；实际符合")
}

func TestOpenquotaOriginalAgeAndFailure(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	used := 25.0
	rows := []Pace{{Account: "codex", UsedPercent: &used, RefreshedAt: now.Format(time.RFC3339)}}
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st := oqStored{Rows: rows}
	body, _ := json.Marshal(st)
	db.ExecContext(ctx, `INSERT INTO quota_cache VALUES (?,?,?,?)`, oqKey, oqKey, string(body), now.UnixMilli())
	deps := Deps{Now: func() time.Time { return now.Add(time.Hour) }}
	local := NewLocal(deps)
	for _, a := range Builtin {
		local.next[a] = now.Add(2 * time.Hour)
	}
	p := poller{local: local, now: deps.Now, oq: func(context.Context) ([]Pace, error) { return nil, errors.New("假来源失败") }}
	if err := p.round(ctx, db); err != nil {
		t.Fatal(err)
	}
	cached, err := openquotaStored(ctx, db)
	if err != nil || cached.Error == "" || len(cached.Rows) != 1 || cached.Rows[0].RefreshedAt != rows[0].RefreshedAt {
		t.Fatal("失败不能换身份或成功时间", cached, err)
	}
	t.Log("预期失败保留旧数/原成功时刻；实际符合")
}

// 当前测试构建的二进制充当假来源，仅 pace 参数触发；不读配置/登录。
func TestMain(m *testing.M) {
	if len(os.Args) >= 3 && os.Args[1] == "pace" && os.Args[2] == "--json" {
		if strings.Contains(filepath.Base(os.Args[0]), "mixed") {
			fmt.Fprintln(os.Stderr, "synthetic corrupt row")
		}
		payload := string(sourceFixture)
		if strings.Contains(filepath.Base(os.Args[0]), "zai") {
			payload = strings.Replace(payload, `"providerId":"opencode"`, `"providerId":"zai"`, 1)
		}
		if strings.Contains(filepath.Base(os.Args[0]), "legacy") {
			payload = string(legacyFixture)
		}
		if strings.Contains(filepath.Base(os.Args[0]), "damaged") {
			payload = strings.Replace(payload, `"quotaCount":2`, `"quotaCount":1`, 1)
		}
		if strings.Contains(filepath.Base(os.Args[0]), "empty") {
			payload = `[]`
		}
		fmt.Println(payload)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestOpenquotaMixedDamagedExitZero(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for _, name := range []string{"clean", "zai", "mixed", "damaged", "empty", "legacy"} {
		suffix := ""
		if strings.HasSuffix(exe, ".exe") {
			suffix = ".exe"
		}
		bin := filepath.Join(dir, name+suffix)
		if err := os.WriteFile(bin, data, 0700); err != nil {
			t.Fatal(err)
		}
		rows, err := readOpenquota(ctx, map[string]string{"HOME": dir, "USERPROFILE": dir, "ATRIUM_OPENQUOTA_BIN": bin})
		if name != "clean" && name != "zai" {
			if err == nil || rows != nil {
				t.Fatal("exit0+坏行警告不能标成功", rows, err)
			}
			if name == "legacy" && !strings.Contains(err.Error(), "缺 quotas/valueMetrics 数组") {
				t.Fatal("旧版出口未写明缺失字段", err)
			}
		} else if err != nil || len(rows) != 1 {
			t.Fatal("正常假来源被拒", rows, err)
		}
		if name == "zai" && rows[0].Account != "zai" {
			t.Fatal("zai 来源未保留", rows)
		}
		t.Logf("%s：预期成功=%v，实际成功=%v，rows=%d，error=%v", name, name == "clean" || name == "zai", err == nil, len(rows), err)
	}
}
