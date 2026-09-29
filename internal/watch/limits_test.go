package watch

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestTickLimitNoticeOnce(t *testing.T) {
	env, ctx := setup(t)
	insertOverPoints(t, env.DB, "o2", org.MaxPoints+1)

	if err := Tick(ctx, env); err != nil {
		t.Fatal(err)
	}
	rows, _ := events.Pending(ctx, env.DB, "a2", false, 10)
	if len(rows) != 1 || rows[0].Kind != events.LimitFull || rows[0].Dept != "o2" || rows[0].Level != events.Act {
		t.Fatalf("超限该给 a2 一条要处理事件：%+v", rows)
	}
	var body map[string]any
	if err := json.Unmarshal(rows[0].Body, &body); err != nil {
		t.Fatal(err)
	}
	if body["key"] != "points" || body["used"] != float64(org.MaxPoints+1) || body["max"] != float64(org.MaxPoints) ||
		body["next"] != "atrium org show o2" {
		t.Fatalf("事件正文应写清哪一项、几/上限、怎么办：%s", rows[0].Body)
	}
	if sec, _ := events.Pending(ctx, env.DB, org.Secretary, false, 10); len(sec) != 0 {
		t.Fatalf("要点超限不该投秘书：%+v", sec)
	}

	if err := Tick(ctx, env); err != nil {
		t.Fatal(err)
	}
	rows2, _ := events.Pending(ctx, env.DB, "a2", false, 10)
	if len(rows2) != 1 || rows2[0].ID != rows[0].ID {
		t.Fatalf("超限期间不该重发：%+v", rows2)
	}

	events.Ack(ctx, env.DB, []int64{rows[0].ID}, "", "a2")
	if err := Tick(ctx, env); err != nil {
		t.Fatal(err)
	}
	if got, _ := events.Pending(ctx, env.DB, "a2", false, 10); len(got) != 0 {
		t.Fatalf("ack 之后不该再发：%+v", got)
	}

	if _, err := env.DB.Exec(`DELETE FROM points WHERE department = 'o2'`); err != nil {
		t.Fatal(err)
	}
	if err := Tick(ctx, env); err != nil {
		t.Fatal(err)
	}
	insertOverPoints(t, env.DB, "o2", org.MaxPoints+1)
	if err := Tick(ctx, env); err != nil {
		t.Fatal(err)
	}
	again, _ := events.Pending(ctx, env.DB, "a2", false, 10)
	if len(again) != 1 || again[0].Kind != events.LimitFull || again[0].ID == rows[0].ID {
		t.Fatalf("回落后再超该再发一条：%+v", again)
	}
}

func TestTickLimitAtMaxAndUserOwner(t *testing.T) {
	env, ctx := setup(t)
	for i := 0; i < org.MaxSecrets; i++ {
		if _, err := env.DB.Exec(`INSERT INTO secrets (department, name, updated_at) VALUES ('o2', ?, 0)`,
			fmt.Sprintf("S%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := Tick(ctx, env); err != nil {
		t.Fatal(err)
	}
	sec, _ := events.Pending(ctx, env.DB, org.Secretary, false, 10)
	if len(sec) != 1 || sec[0].Kind != events.LimitFull {
		t.Fatalf("凭据满了找用户，经秘书：%+v", sec)
	}
	if a2, _ := events.Pending(ctx, env.DB, "a2", false, 10); len(a2) != 0 {
		t.Fatalf("凭据满了不该投部门负责人：%+v", a2)
	}
	if err := Tick(ctx, env); err != nil {
		t.Fatal(err)
	}
	if got, _ := events.Pending(ctx, env.DB, org.Secretary, false, 10); len(got) != 1 {
		t.Fatalf("刚到上限也只提醒一次：%+v", got)
	}
}

func TestTickLimitSurvivesReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.db")
	env, ctx := openWatchEnv(t, path)
	insertOverPoints(t, env.DB, "o2", org.MaxPoints+1)
	if err := Tick(ctx, env); err != nil {
		t.Fatal(err)
	}
	first, _ := events.Pending(ctx, env.DB, "a2", false, 10)
	if len(first) != 1 {
		t.Fatalf("应发一条：%+v", first)
	}
	id := first[0].ID
	env.DB.Close()

	env, ctx = openWatchEnv(t, path)
	if err := Tick(ctx, env); err != nil {
		t.Fatal(err)
	}
	again, _ := events.Pending(ctx, env.DB, "a2", false, 10)
	if len(again) != 1 || again[0].ID != id {
		t.Fatalf("关掉库再打开不该重发：先 %+v 后 %+v", first, again)
	}
	var n int
	if err := env.DB.QueryRow(`SELECT count(*) FROM events WHERE kind = ?`, events.LimitFull).Scan(&n); err != nil || n != 1 {
		t.Fatalf("事件表应仍是 1 条，得到 %d %v", n, err)
	}
}

func openWatchEnv(t *testing.T, path string) (*app.Env, context.Context) {
	t.Helper()
	db, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	for _, q := range []string{
		`INSERT OR IGNORE INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0), ('a2', 'leader', '乙', 0)`,
		`INSERT OR IGNORE INTO departments (id, parent, name, leader, created_at, updated_at) VALUES ('o1', NULL, '公司', 'a1', 0, 0)`,
		`INSERT OR IGNORE INTO departments (id, parent, name, leader, created_at, updated_at) VALUES ('o2', 'o1', '运行时', 'a2', 0, 0)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	mem.m = map[string]*progress{}
	return &app.Env{DB: db, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Pause: &pause.Store{DB: db}}, context.Background()
}

func insertOverPoints(t *testing.T, db *store.DB, dept string, n int) {
	t.Helper()
	var maxPos int
	if err := db.QueryRow(`SELECT COALESCE(max(pos), 0) FROM points WHERE department = ?`, dept).Scan(&maxPos); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= n; i++ {
		pos := maxPos + i
		id := fmt.Sprintf("k%s-%d", dept, pos)
		if _, err := db.Exec(`INSERT INTO points (id, department, pos, text, decided_by, updated_by, updated_at)
			VALUES (?, ?, ?, '规矩', 'u1', 'import', 0)`, id, dept, pos); err != nil {
			t.Fatal(err)
		}
	}
}
