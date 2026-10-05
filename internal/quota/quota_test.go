package quota

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// magpieServer 起一个只回空套餐的假 magpie，返回 URL 与请求计数。
func magpieServer(t *testing.T) (*httptest.Server, *int) {
	t.Helper()
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Write([]byte(`{"data":[]}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestLocalCache(t *testing.T) {
	srv, calls := magpieServer(t)
	now := time.UnixMilli(1_800_000_000_000)
	d := Deps{HTTP: srv.Client(), Now: func() time.Time { return now }, URLs: map[string]string{MagpieAccount: srv.URL}}
	l := NewLocal(d)
	if got := l.Due(context.Background(), nil); len(got) != 1 || !got[0].OK {
		t.Fatalf("第一次应读 magpie：%+v", got)
	}
	if got := l.Due(context.Background(), nil); len(got) != 0 {
		t.Fatalf("缓存内不该再读：%d", len(got))
	}
	now = now.Add(okTTL)
	if got := l.Due(context.Background(), nil); len(got) != 1 || *calls != 2 {
		t.Fatalf("到期应再读：%d，请求 %d 次", len(got), *calls)
	}
}

func TestRecordAndReserve(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	now := store.Now()
	w := []Window{{ID: "weekly", Used: 40, Period: 604800}}
	// 相同/不同指纹都按机器保留，不能证明账号或套餐关系。
	if err := Record(ctx, db, "h1", []Reading{{Account: MagpieAccount, OK: true, Finger: "A", ReadAt: now - 1000, Windows: w}}); err != nil {
		t.Fatal(err)
	}
	if err := Record(ctx, db, "h3", []Reading{{Account: MagpieAccount, OK: true, Finger: "A", ReadAt: now, Windows: w}}); err != nil {
		t.Fatal(err)
	}
	if err := Record(ctx, db, "h2", []Reading{{Account: MagpieAccount, OK: true, Finger: "B", ReadAt: now, Windows: w}}); err != nil {
		t.Fatal(err)
	}
	if Record(ctx, db, "h2", []Reading{{Account: "bogus"}}) == nil {
		t.Error("不认识的账号应拒绝")
	}
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM quota_cache`).Scan(&n)
	if n != 3 {
		t.Errorf("应有 3 行（各机器来源），得 %d", n)
	}
	// h2 正常刷新换来源指纹，只替换该机器行。
	Record(ctx, db, "h2", []Reading{{Account: MagpieAccount, OK: true, Finger: "A", ReadAt: now + 1, Windows: w}})
	db.QueryRow(`SELECT COUNT(*) FROM quota_cache WHERE tool = ?`, MagpieAccount).Scan(&n)
	if n != 3 {
		t.Errorf("换来源后其他机器两行仍保留，共 3 行，得 %d", n)
	}
	db.Exec(`INSERT INTO quota_settings (name, value) VALUES ('reserve_percent', 50)`)
	env := &app.Env{DB: db, Paths: config.Paths{Data: t.TempDir()}}
	// 隔离实例没有后台读取，只保留缓存与设置。
	if err := loop(ctx, env); err != nil {
		t.Fatal(err)
	}
	reserve, err := Reserve(ctx, db)
	all, readErr := Cached(ctx, db)
	if err != nil || readErr != nil || reserve != 50 || len(all) != 3 {
		t.Fatalf("reserve=%d rows=%d err=%v readErr=%v", reserve, len(all), err, readErr)
	}
}

// 后台读取：magpie 读数与 OpenQuota 都存进库，重启后（新的读取器）缓存照样有；OpenQuota 到期才再跑。
func TestPoller(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	srv, _ := magpieServer(t)
	now := time.UnixMilli(1_800_000_000_000)
	d := Deps{HTTP: srv.Client(), Now: func() time.Time { return now }, URLs: map[string]string{MagpieAccount: srv.URL}}
	used := 30.0
	runs := 0
	var oqErr error
	p := &poller{local: NewLocal(d), now: d.Now, oq: func(context.Context) ([]Pace, error) {
		runs++
		if oqErr != nil {
			return nil, oqErr
		}
		return []Pace{{Account: "kimi", UsedPercent: &used}}, nil
	}}
	if err := p.round(ctx, db); err != nil {
		t.Fatal(err)
	}
	all, err := Cached(ctx, db)
	if err != nil || len(all) != 1 {
		t.Fatalf("本机假读数未存下：%v %d", err, len(all))
	}
	oq, err := openquotaStored(ctx, db)
	if err != nil || len(oq.Rows) != 1 || *oq.Rows[0].UsedPercent != 30 {
		t.Fatalf("OpenQuota 假读数未存下：%+v %v", oq, err)
	}
	now = now.Add(time.Minute)
	p.round(ctx, db)
	if runs != 1 {
		t.Errorf("OpenQuota 5 分钟内不该再跑：%d 次", runs)
	}
	now = now.Add(okTTL)
	oqErr = errors.New("OpenQuota 读取失败")
	if err := p.round(ctx, db); err != nil || runs != 2 {
		t.Fatalf("到期应再跑：%v %d", err, runs)
	}
	oq, err = openquotaStored(ctx, db)
	if err != nil || oq.Error != "OpenQuota 读取失败" || len(oq.Rows) != 1 || *oq.Rows[0].UsedPercent != 30 {
		t.Fatalf("失败应保留旧读数：%+v %v", oq, err)
	}
	// OpenQuota 那一行不混进各台读数。
	all, err = stored(ctx, db)
	if err != nil || len(all) != 1 {
		t.Errorf("各台读数应是 magpie 一家：%v %d", err, len(all))
	}
}
