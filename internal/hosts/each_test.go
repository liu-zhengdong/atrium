package hosts

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestUsableHostsIsolatesBadRecord(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	if err := EnsureLocal(ctx, db, Info{}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO hosts(id,name,kind,repos,created_at) VALUES('h2','bad','remote','{broken',0)`); err != nil {
		t.Fatal(err)
	}
	env := &app.Env{DB: db, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for i := 0; i < 2; i++ {
		got, err := usableHosts(ctx, env)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 1 || got[0].ID != Local {
			t.Fatalf("got=%+v", got)
		}
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM events WHERE kind='host.record_failed'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("notifications=%d", count)
	}
	if _, err := db.Exec(`UPDATE hosts SET repos='[]' WHERE id='h2'`); err != nil {
		t.Fatal(err)
	}
	got, err := usableHosts(ctx, env)
	if err != nil || len(got) != 2 {
		t.Fatalf("恢复登记后 got=%+v err=%v", got, err)
	}
}
